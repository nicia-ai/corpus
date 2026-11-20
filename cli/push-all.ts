import {
  type DocSummary,
  fetchDocument,
  listCorpus,
  type SyncConfig,
  type TreeFiles,
} from "./core.js";
import { CliError } from "./errors.js";
import { type Grant, grantAllows } from "./grant.js";
import {
  createDocument,
  moveDocument,
  removeDocument,
  putDocument,
  type WriteOutcome,
} from "./rest-write.js";
import {
  collisionKey,
  type PendingProposal,
  pendingProposals,
  serializeState,
  sha256Hex,
  STATE_FILE,
  type SyncState,
  type TrackedFile,
  unsafePathProblem,
} from "./sync-state.js";
import { joinPath, readState, requireIdentity } from "./sync.js";

// Whole-checkout push: send what changed in a `pull --all` directory back to
// Corpus, governed by the key's grant (read < suggest < edit):
//
//   edit    — modified, new, renamed and deleted files are applied
//   suggest — modified and new files are filed as proposals a person reviews;
//             removals and renames cannot be proposed and are reported
//   read    — refused before anything is sent
//
// The run is planned completely (listing, local reads) before the first write
// request. A tracked file whose upstream moved since the last pull is a
// conflict: it is left alone, reported, and the rest of the run continues.
// Portable like the rest of the core: only `fetch` and the `PushFiles` port.

const MARKDOWN_EXTENSION = ".md";
const SIDECAR_SUFFIX = ".corpus.json";
const GIT_SEGMENT = ".git";

// A `TreeFiles` that can also list a directory's candidate files: paths
// relative to `dir`, `/`-separated. The host decides which files exist for
// this purpose (the Node shell asks git, so `.gitignore` is respected).
export type PushFiles = TreeFiles &
  Readonly<{ listFiles: (dir: string) => Promise<readonly string[]> }>;

export type PushConfig = Readonly<
  Omit<SyncConfig, "files"> & { files: PushFiles }
>;

export type PushAllOptions = Readonly<{ dryRun?: boolean }>;

export type PlannedAction = Readonly<
  | {
      kind: "update";
      path: string;
      slug: string;
      baseVersion: number;
      markdown: string;
      sha256: string;
    }
  | { kind: "create"; path: string; markdown: string; sha256: string }
  | {
      kind: "archive";
      path: string;
      slug: string;
      baseVersion: number;
    }
  | {
      kind: "move";
      from: string;
      path: string;
      slug: string;
      docVersion: number;
      sha256: string;
    }
>;

export type PushConflictReason =
  "changed-upstream" | "deleted-upstream" | "path-taken";

export type PushConflict = Readonly<{
  path: string;
  slug: string | undefined;
  reason: PushConflictReason;
}>;

export type PushSkipReason = "removal-needs-edit" | "already-proposed";

export type PushSkip = Readonly<{
  path: string;
  reason: PushSkipReason;
  proposalId?: number;
}>;

export type AppliedChange = Readonly<{
  path: string;
  action: "updated" | "created" | "archived" | "moved";
  from?: string;
}>;

export type ProposedChange = Readonly<{
  path: string;
  kind: "edit" | "create";
  proposalId: number;
  reviewUrl: string | undefined;
}>;

export type PushFailure = Readonly<{ path: string; message: string }>;

export type PushReport = Readonly<{
  grant: Grant;
  dryRun: boolean;
  planned: readonly PlannedAction[];
  applied: readonly AppliedChange[];
  proposed: readonly ProposedChange[];
  skipped: readonly PushSkip[];
  conflicts: readonly PushConflict[];
  failed: readonly PushFailure[];
  ignored: readonly string[];
  unchanged: number;
}>;

type Local = Readonly<{ text: string; sha256: string }>;

type Plan = Readonly<{
  actions: readonly PlannedAction[];
  skipped: readonly PushSkip[];
  conflicts: readonly PushConflict[];
  ignored: readonly string[];
  unchanged: number;
  // Tracked entries whose bytes now match upstream's newer version: the
  // change was already applied there, so the state just catches up.
  caughtUp: readonly TrackedFile[];
}>;

export async function pushAll(
  cfg: PushConfig,
  dir: string,
  options: PushAllOptions = {},
): Promise<PushReport> {
  const dryRun = options.dryRun === true;
  const at = (path: string): string => joinPath(dir, path);
  const listing = await listCorpus(cfg);
  if (!grantAllows(listing.grant, "suggest")) {
    throw new CliError(
      "forbidden",
      `this key has ${listing.grant} access, so it cannot push; push needs suggest ` +
        "(files become proposals) or edit (files are written directly) access. " +
        "An organization owner can change the key's access.",
    );
  }
  const identity = requireIdentity(listing.corpus);
  if ((await cfg.files.readText(at(STATE_FILE))) === undefined) {
    throw new CliError(
      "state",
      `no ${STATE_FILE} in ${dir}: run "corpus pull --all ${dir}" first, so push can tell your edits from upstream's.`,
    );
  }
  const state = await readState(cfg, at(STATE_FILE), identity);
  const plan = await planPush({
    cfg,
    dir,
    grant: listing.grant,
    documents: listing.documents,
    state,
  });
  const base = {
    grant: listing.grant,
    dryRun,
    planned: plan.actions,
    skipped: plan.skipped,
    ignored: plan.ignored,
    unchanged: plan.unchanged,
  };
  if (dryRun) {
    return {
      ...base,
      applied: [],
      proposed: [],
      conflicts: plan.conflicts,
      failed: [],
    };
  }
  const run = new Execution(cfg, state, plan.caughtUp, plan.conflicts);
  try {
    for (const action of orderForExecution(plan.actions)) {
      await run.perform(action);
    }
  } finally {
    const serialized = serializeState(run.state());
    if (serialized !== (await cfg.files.readText(at(STATE_FILE)))) {
      await cfg.files.writeText(at(STATE_FILE), serialized);
    }
  }
  return {
    ...base,
    applied: run.applied,
    proposed: run.proposed,
    conflicts: run.conflicts,
    failed: run.failed,
  };
}

// Removals first, so a path they free can be taken by a move or a create.
const EXECUTION_ORDER: Readonly<Record<PlannedAction["kind"], number>> = {
  archive: 0,
  move: 1,
  update: 2,
  create: 3,
};

function orderForExecution(
  actions: readonly PlannedAction[],
): readonly PlannedAction[] {
  return [...actions].sort(
    (a, b) => EXECUTION_ORDER[a.kind] - EXECUTION_ORDER[b.kind],
  );
}

// — Planning ————————————————————————————————————————————————————————

const isMarkdown = (path: string): boolean =>
  path.toLowerCase().endsWith(MARKDOWN_EXTENSION);

const isBookkeeping = (path: string): boolean =>
  path === STATE_FILE ||
  path.endsWith(SIDECAR_SUFFIX) ||
  path.split("/").some((s) => s.toLowerCase() === GIT_SEGMENT);

async function planPush(
  input: Readonly<{
    cfg: PushConfig;
    dir: string;
    grant: Grant;
    documents: readonly DocSummary[];
    state: SyncState;
  }>,
): Promise<Plan> {
  const { cfg, dir, grant, documents, state } = input;
  const canEdit = grantAllows(grant, "edit");
  const at = (path: string): string => joinPath(dir, path);
  const readLocal = async (path: string): Promise<Local | undefined> => {
    const text = await cfg.files.readText(at(path));
    return text === undefined
      ? undefined
      : { text, sha256: await sha256Hex(text) };
  };
  const remoteBySlug = new Map(documents.map((d) => [d.slug, d] as const));
  const remoteByPath = new Map(
    documents.flatMap((d) => (d.path === undefined ? [] : [[d.path, d]])),
  );
  const trackedPaths = new Set(state.files.map((f) => f.path));
  const pending = pendingProposals(state);

  const candidates = (await cfg.files.listFiles(dir)).filter(
    (p) => !isBookkeeping(p),
  );
  const ignored = candidates.filter((p) => !isMarkdown(p)).sort();
  const newPaths = candidates
    .filter((p) => isMarkdown(p) && !trackedPaths.has(p))
    .sort();
  requireSafeNewPaths(newPaths, state.files);

  const actions: PlannedAction[] = [];
  const skipped: PushSkip[] = [];
  const conflicts: PushConflict[] = [];
  const caughtUp: TrackedFile[] = [];
  const deleted: TrackedFile[] = [];
  let unchanged = 0;

  for (const entry of state.files) {
    const local = await readLocal(entry.path);
    const remote = remoteBySlug.get(entry.slug);
    const upstreamMoved =
      remote !== undefined &&
      (remote.docVersion !== entry.docVersion || remote.path !== entry.path);
    if (local === undefined) {
      if (remote === undefined) continue;
      if (upstreamMoved) {
        conflicts.push(conflict(entry, "changed-upstream"));
      } else if (canEdit) {
        deleted.push(entry);
      } else {
        skipped.push({ path: entry.path, reason: "removal-needs-edit" });
      }
      continue;
    }
    if (local.sha256 === entry.sha256) {
      unchanged += 1;
      continue;
    }
    if (remote === undefined) {
      conflicts.push(conflict(entry, "deleted-upstream"));
      continue;
    }
    if (upstreamMoved) {
      const upstream = await fetchDocument(cfg, entry.slug);
      if (
        remote.path === entry.path &&
        (await sha256Hex(upstream.markdown)) === local.sha256
      ) {
        caughtUp.push({
          ...entry,
          docVersion: upstream.docVersion,
          sha256: local.sha256,
        });
      } else {
        conflicts.push(conflict(entry, "changed-upstream"));
      }
      continue;
    }
    const filed = pending.find(
      (p) =>
        p.path === entry.path &&
        p.sha256 === local.sha256 &&
        p.baseVersion === entry.docVersion,
    );
    if (!canEdit && filed !== undefined) {
      skipped.push({
        path: entry.path,
        reason: "already-proposed",
        proposalId: filed.proposalId,
      });
      continue;
    }
    actions.push({
      kind: "update",
      path: entry.path,
      slug: entry.slug,
      baseVersion: entry.docVersion,
      markdown: local.text,
      sha256: local.sha256,
    });
  }

  const unpaired = new Set(newPaths);
  if (canEdit) {
    const available = [...deleted].sort((a, b) => a.path.localeCompare(b.path));
    for (const path of newPaths) {
      const local = await readLocal(path);
      const index = available.findIndex((e) => e.sha256 === local?.sha256);
      const entry = available[index];
      if (local === undefined || entry === undefined) continue;
      available.splice(index, 1);
      unpaired.delete(path);
      deleted.splice(deleted.indexOf(entry), 1);
      actions.push({
        kind: "move",
        from: entry.path,
        path,
        slug: entry.slug,
        docVersion: entry.docVersion,
        sha256: local.sha256,
      });
    }
    for (const entry of deleted) {
      actions.push({
        kind: "archive",
        path: entry.path,
        slug: entry.slug,
        baseVersion: entry.docVersion,
      });
    }
  }

  for (const path of [...unpaired].sort()) {
    const local = await readLocal(path);
    if (local === undefined) continue;
    const occupant = remoteByPath.get(path);
    if (occupant !== undefined) {
      conflicts.push({ path, slug: occupant.slug, reason: "path-taken" });
      continue;
    }
    const filed = pending.find(
      (p) =>
        p.path === path && p.baseVersion === 0 && p.sha256 === local.sha256,
    );
    if (!canEdit && filed !== undefined) {
      skipped.push({
        path,
        reason: "already-proposed",
        proposalId: filed.proposalId,
      });
      continue;
    }
    actions.push({
      kind: "create",
      path,
      markdown: local.text,
      sha256: local.sha256,
    });
  }

  return { actions, skipped, conflicts, ignored, unchanged, caughtUp };
}

function conflict(
  entry: TrackedFile,
  reason: PushConflictReason,
): PushConflict {
  return { path: entry.path, slug: entry.slug, reason };
}

// A new file's path becomes a document path in Corpus: refuse the whole run
// (before anything is sent) when one is unsafe or would share a file with
// another path on a case-insensitive filesystem.
function requireSafeNewPaths(
  newPaths: readonly string[],
  tracked: readonly TrackedFile[],
): void {
  const seen = new Map(
    tracked.map((f) => [collisionKey(f.path), f.path] as const),
  );
  for (const path of newPaths) {
    const problem = unsafePathProblem(path);
    if (problem !== undefined) {
      throw new CliError(
        "unsafe-path",
        `refusing to push "${path}": ${problem}. Rename or ignore the file.`,
      );
    }
    const other = seen.get(collisionKey(path));
    if (other !== undefined) {
      throw new CliError(
        "unsafe-path",
        `"${other}" and "${path}" differ only by case or Unicode form and would be one document path in a case-insensitive checkout; rename one.`,
      );
    }
    seen.set(collisionKey(path), path);
  }
}

// — Execution ———————————————————————————————————————————————————————

// Applies planned actions one request at a time, keeping the state file's
// view of what is synced exactly in step with what the server accepted.
class Execution {
  readonly applied: AppliedChange[] = [];
  readonly proposed: ProposedChange[] = [];
  readonly failed: PushFailure[] = [];
  readonly conflicts: PushConflict[];
  private readonly files: Map<string, TrackedFile>;
  private proposals: PendingProposal[];

  constructor(
    private readonly cfg: PushConfig,
    private readonly previous: SyncState,
    caughtUp: readonly TrackedFile[],
    conflicts: readonly PushConflict[],
  ) {
    this.files = new Map(previous.files.map((f) => [f.path, f] as const));
    for (const entry of caughtUp) this.files.set(entry.path, entry);
    this.proposals = [...pendingProposals(previous)];
    this.conflicts = [...conflicts];
  }

  state(): SyncState {
    return {
      ...this.previous,
      files: [...this.files.values()],
      proposals: this.proposals,
    };
  }

  async perform(action: PlannedAction): Promise<void> {
    switch (action.kind) {
      case "update": {
        this.settleUpdate(
          action,
          await putDocument(this.cfg, {
            slug: action.slug,
            markdown: action.markdown,
            clientVersion: action.baseVersion,
          }),
        );
        return;
      }
      case "create": {
        this.settleCreate(
          action,
          await createDocument(this.cfg, {
            markdown: action.markdown,
            path: action.path,
          }),
        );
        return;
      }
      case "archive": {
        this.settleArchive(
          action,
          await removeDocument(this.cfg, {
            slug: action.slug,
            clientVersion: action.baseVersion,
          }),
        );
        return;
      }
      case "move": {
        this.settleMove(
          action,
          await moveDocument(this.cfg, {
            slug: action.slug,
            path: action.path,
          }),
        );
        return;
      }
    }
  }

  private settleUpdate(
    action: Extract<PlannedAction, { kind: "update" }>,
    outcome: WriteOutcome,
  ): void {
    switch (outcome.kind) {
      case "written":
        this.files.set(action.path, {
          path: action.path,
          slug: action.slug,
          docVersion: outcome.docVersion,
          sha256: action.sha256,
        });
        this.applied.push({ path: action.path, action: "updated" });
        return;
      case "proposed":
        this.rememberProposal(
          action,
          action.baseVersion,
          outcome.proposal.proposalId,
        );
        this.proposed.push({
          path: action.path,
          kind: "edit",
          proposalId: outcome.proposal.proposalId,
          reviewUrl: outcome.proposal.reviewUrl,
        });
        return;
      case "unchanged":
        return;
      default:
        this.settleRefusal(action.path, action.slug, outcome);
    }
  }

  private settleCreate(
    action: Extract<PlannedAction, { kind: "create" }>,
    outcome: WriteOutcome,
  ): void {
    switch (outcome.kind) {
      case "written":
        if (outcome.slug === undefined) {
          this.failed.push({
            path: action.path,
            message: "the server did not return the new document's slug",
          });
          return;
        }
        this.files.set(action.path, {
          path: action.path,
          slug: outcome.slug,
          docVersion: outcome.docVersion,
          sha256: action.sha256,
        });
        this.applied.push({ path: action.path, action: "created" });
        return;
      case "proposed":
        this.rememberProposal(action, 0, outcome.proposal.proposalId);
        this.proposed.push({
          path: action.path,
          kind: "create",
          proposalId: outcome.proposal.proposalId,
          reviewUrl: outcome.proposal.reviewUrl,
        });
        return;
      default:
        this.settleRefusal(action.path, undefined, outcome);
    }
  }

  private settleArchive(
    action: Extract<PlannedAction, { kind: "archive" }>,
    outcome: WriteOutcome,
  ): void {
    if (outcome.kind === "removed" || outcome.kind === "gone") {
      this.files.delete(action.path);
      this.applied.push({ path: action.path, action: "archived" });
      return;
    }
    this.settleRefusal(action.path, action.slug, outcome);
  }

  private settleMove(
    action: Extract<PlannedAction, { kind: "move" }>,
    outcome: WriteOutcome,
  ): void {
    if (outcome.kind === "moved") {
      this.files.delete(action.from);
      this.files.set(action.path, {
        path: action.path,
        slug: action.slug,
        docVersion: action.docVersion,
        sha256: action.sha256,
      });
      this.applied.push({
        path: action.path,
        action: "moved",
        from: action.from,
      });
      return;
    }
    this.settleRefusal(action.from, action.slug, outcome);
  }

  private settleRefusal(
    path: string,
    slug: string | undefined,
    outcome: WriteOutcome,
  ): void {
    switch (outcome.kind) {
      case "conflict":
        this.conflicts.push({ path, slug, reason: "changed-upstream" });
        return;
      case "gone":
        this.conflicts.push({ path, slug, reason: "deleted-upstream" });
        return;
      case "path-taken":
        this.conflicts.push({ path, slug, reason: "path-taken" });
        return;
      case "rolled-back":
        this.failed.push({
          path,
          message: "the write could not be completed atomically; retry it",
        });
        return;
      case "refused":
        this.failed.push({ path, message: outcome.message });
        return;
      default:
        this.failed.push({
          path,
          message: `unexpected response (${outcome.kind})`,
        });
    }
  }

  private rememberProposal(
    action: Readonly<{ path: string; sha256: string }>,
    baseVersion: number,
    proposalId: number,
  ): void {
    this.proposals = [
      ...this.proposals.filter((p) => p.path !== action.path),
      { path: action.path, baseVersion, sha256: action.sha256, proposalId },
    ];
  }
}

// — Output ——————————————————————————————————————————————————————————

const CONFLICT_TEXT: Readonly<Record<PushConflictReason, string>> = {
  "changed-upstream": "changed upstream since your last pull",
  "deleted-upstream": "removed upstream",
  "path-taken": "that path is already a document upstream",
};

const SKIP_TEXT: Readonly<Record<PushSkipReason, string>> = {
  "removal-needs-edit":
    "deleted locally, but a removal cannot be proposed; it needs edit access (a later pull restores the file)",
  "already-proposed": "already proposed; unchanged since",
};

function describePlanned(action: PlannedAction, grant: Grant): string {
  const proposing = !grantAllows(grant, "edit");
  switch (action.kind) {
    case "update":
      return `${proposing ? "propose edit" : "update"}  ${action.path}  [${action.slug} v${String(action.baseVersion)}]`;
    case "create":
      return `${proposing ? "propose new" : "create"}  ${action.path}`;
    case "archive":
      return `archive  ${action.path}  [${action.slug}]`;
    case "move":
      return `move  ${action.from} -> ${action.path}  [${action.slug}]`;
  }
}

// The report as the lines `corpus push --all` prints. Pure, so tests assert
// on exactly what a CI log shows.
export function formatPushReport(
  report: PushReport,
  dir: string,
): readonly string[] {
  const lines: string[] = [];
  if (report.dryRun) {
    lines.push(
      `dry run (${report.grant} access): nothing was sent. ${String(report.planned.length)} change(s) planned in ${dir}`,
    );
    for (const a of report.planned)
      lines.push(`  ${describePlanned(a, report.grant)}`);
  } else {
    const parts = [
      ...(report.applied.length > 0
        ? [`applied ${String(report.applied.length)}`]
        : []),
      ...(report.proposed.length > 0
        ? [`proposed ${String(report.proposed.length)}`]
        : []),
    ];
    lines.push(
      parts.length === 0
        ? `nothing to push: ${String(report.unchanged)} file(s) unchanged in ${dir}`
        : `${parts.join(", ")}, unchanged ${String(report.unchanged)}`,
    );
    for (const c of report.applied) {
      lines.push(
        c.from === undefined
          ? `${APPLIED_MARK[c.action]} ${c.path}`
          : `${APPLIED_MARK[c.action]} ${c.from} -> ${c.path}`,
      );
    }
    for (const p of report.proposed) {
      lines.push(
        `? ${p.path}  proposal #${String(p.proposalId)}${p.reviewUrl === undefined ? "" : `  review: ${p.reviewUrl}`}`,
      );
    }
    if (report.proposed.length > 0) {
      lines.push(
        "These are proposals, not edits: nothing in Corpus has changed until a person applies them. " +
          "Your local files keep their edits; `corpus pull --all` updates them once a proposal is applied.",
      );
    }
  }
  for (const s of report.skipped) {
    lines.push(
      `skipped ${s.path}: ${SKIP_TEXT[s.reason]}${s.proposalId === undefined ? "" : ` (#${String(s.proposalId)})`}`,
    );
  }
  if (report.ignored.length > 0) {
    lines.push(
      `ignored ${String(report.ignored.length)} non-markdown file(s):`,
    );
    for (const path of report.ignored) lines.push(`  ${path}`);
  }
  if (report.failed.length > 0) {
    lines.push(`${String(report.failed.length)} failed:`);
    for (const f of report.failed) lines.push(`  ${f.path}: ${f.message}`);
  }
  if (report.conflicts.length > 0) {
    lines.push(
      `${String(report.conflicts.length)} conflict(s), left untouched:`,
    );
    for (const c of report.conflicts) {
      lines.push(
        `  ${c.path}  [${c.slug ?? "?"}]  (${CONFLICT_TEXT[c.reason]})`,
      );
    }
    lines.push(
      "To resolve: run `corpus pull --all` to see upstream's state, reapply your edit to the file, and push again; " +
        "or `corpus pull --all --overwrite` to take upstream's (local edits are discarded).",
    );
  }
  return lines;
}

const APPLIED_MARK: Readonly<Record<AppliedChange["action"], string>> = {
  updated: "~",
  created: "+",
  archived: "-",
  moved: ">",
};
