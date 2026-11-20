import {
  type DocFull,
  type DocSummary,
  fetchDocument,
  listCorpus,
  type SyncConfig,
} from "./core.js";
import { CliError } from "./errors.js";
import {
  collisionKey,
  type CorpusIdentity,
  emptyState,
  parseState,
  sameCorpus,
  serializeState,
  sha256Hex,
  STATE_FILE,
  type SyncState,
  type TrackedFile,
  unsafePathProblem,
} from "./sync-state.js";

// Whole-corpus pull: materialize every document of the key's corpus as an
// ordinary folder tree under `dir`, tracked by one `.corpus.json` state file.
// Portable like the rest of the core: only `fetch` and the `TreeFiles` port.
//
// The run is planned completely (listing, content fetches, local reads)
// before the first byte is written, so a transport failure leaves the
// directory untouched. Local edits are detected by comparing a file's bytes
// to the hash recorded when this tool last wrote it; an edited file is never
// overwritten or deleted without `overwrite`.

const FETCH_BATCH_SIZE = 8;

export type SyncOptions = Readonly<{ overwrite?: boolean }>;

export type ConflictReason =
  "edited-locally" | "deleted-upstream" | "untracked-in-the-way" | "path-taken";

export type SyncConflict = Readonly<{
  slug: string | undefined;
  path: string;
  reason: ConflictReason;
}>;

export type SyncChange = Readonly<{ path: string; from?: string }>;

export type SyncReport = Readonly<{
  added: readonly SyncChange[];
  updated: readonly SyncChange[];
  removed: readonly string[];
  unchanged: readonly string[];
  keptLocal: readonly string[];
  conflicts: readonly SyncConflict[];
}>;

type Remote = Readonly<{ slug: string; path: string; docVersion: number }>;
type Local = Readonly<{ text: string; sha256: string }>;

type Fetched = Readonly<{
  remote: Remote;
  base: TrackedFile | undefined;
  doc: DocFull;
  sha256: string;
}>;

type Stay = Readonly<{
  kind: "stay";
  entry: TrackedFile;
  editedLocally: boolean;
}>;
type Write = Readonly<{
  kind: "write";
  fetched: Fetched;
  baseWasPresent: boolean;
  needsWrite: boolean;
  occupiedByTracked: boolean;
}>;
type Remove = Readonly<{ kind: "remove"; entry: TrackedFile }>;
type Blocked = Readonly<{
  kind: "blocked";
  entry: TrackedFile | undefined;
  conflict: SyncConflict;
}>;
type Decision = Stay | Write | Remove | Blocked;

export async function pullAll(
  cfg: SyncConfig,
  dir: string,
  options: SyncOptions = {},
): Promise<SyncReport> {
  const overwrite = options.overwrite === true;
  const { files } = cfg;
  const at = (path: string): string => joinPath(dir, path);

  const listing = await listCorpus(cfg);
  const identity = requireIdentity(listing.corpus);
  const remote = validatedRemote(listing.documents);
  const state = await readState(cfg, at(STATE_FILE), identity);

  const localCache = new Map<string, Local | undefined>();
  const readLocal = async (path: string): Promise<Local | undefined> => {
    if (localCache.has(path)) return localCache.get(path);
    const text = await files.readText(at(path));
    const local =
      text === undefined ? undefined : { text, sha256: await sha256Hex(text) };
    localCache.set(path, local);
    return local;
  };

  const trackedBySlug = new Map(state.files.map((f) => [f.slug, f] as const));
  const trackedByPath = new Map(state.files.map((f) => [f.path, f] as const));
  const remoteSlugs = new Set(remote.map((r) => r.slug));

  const decisions: Decision[] = [];
  const toFetch: { remote: Remote; base: TrackedFile | undefined }[] = [];
  for (const r of remote) {
    const base = trackedBySlug.get(r.slug);
    const upstreamUnchanged =
      base?.path === r.path && base.docVersion === r.docVersion;
    const current = upstreamUnchanged ? await readLocal(base.path) : undefined;
    if (upstreamUnchanged && current !== undefined) {
      const editedLocally = current.sha256 !== base.sha256;
      if (!editedLocally || !overwrite) {
        decisions.push({ kind: "stay", entry: base, editedLocally });
        continue;
      }
    }
    toFetch.push({ remote: r, base });
  }

  const fetched = await fetchAll(cfg, toFetch);
  for (const f of fetched) {
    decisions.push(await decideWrite(f, readLocal, trackedByPath, overwrite));
  }

  for (const entry of state.files) {
    if (remoteSlugs.has(entry.slug)) continue;
    const current = await readLocal(entry.path);
    const edited = current !== undefined && current.sha256 !== entry.sha256;
    decisions.push(
      edited && !overwrite
        ? {
            kind: "blocked",
            entry,
            conflict: {
              slug: entry.slug,
              path: entry.path,
              reason: "deleted-upstream",
            },
          }
        : { kind: "remove", entry },
    );
  }

  const settled = settlePathContention(decisions);
  await apply(cfg, dir, settled, readLocal);
  const nextState = buildState(state, settled);
  const serialized = serializeState(nextState);
  if (serialized !== (await files.readText(at(STATE_FILE)))) {
    await files.writeText(at(STATE_FILE), serialized);
  }
  return buildReport(settled);
}

export function requireIdentity(
  corpus: CorpusIdentity | undefined,
): CorpusIdentity {
  if (corpus === undefined) {
    throw new CliError(
      "unsupported",
      "this Corpus server does not report the corpus identity or document paths; upgrade it to use pull --all.",
    );
  }
  return corpus;
}

// Reject the whole run, before any write, when a server-supplied path is
// unsafe to materialize or two paths would share one file on a
// case-insensitive filesystem.
function validatedRemote(documents: readonly DocSummary[]): readonly Remote[] {
  const seen = new Map<string, string>();
  return documents.map((d) => {
    if (d.path === undefined) {
      throw new CliError(
        "unsupported",
        `the server did not report a path for "${d.slug}"; upgrade it to use pull --all.`,
      );
    }
    const problem = unsafePathProblem(d.path);
    if (problem !== undefined) {
      throw new CliError(
        "unsafe-path",
        `refusing document "${d.slug}" at path "${d.path}": ${problem}.`,
      );
    }
    const key = collisionKey(d.path);
    const other = seen.get(key);
    if (other !== undefined) {
      throw new CliError(
        "unsafe-path",
        `"${other}" and "${d.path}" differ only by case or Unicode form and would share one file on a case-insensitive filesystem; rename one in Corpus.`,
      );
    }
    seen.set(key, d.path);
    return { slug: d.slug, path: d.path, docVersion: d.docVersion };
  });
}

export async function readState(
  cfg: SyncConfig,
  statePath: string,
  identity: CorpusIdentity,
): Promise<SyncState> {
  const raw = await cfg.files.readText(statePath);
  if (raw === undefined) return emptyState(identity);
  const state = parseState(raw, statePath);
  if (!sameCorpus(state.corpus, identity)) {
    throw new CliError(
      "state",
      `${statePath} belongs to corpus "${state.corpus.slug}" (project ${state.corpus.projectId}), ` +
        `but this API key is bound to "${identity.slug}" (project ${identity.projectId}). ` +
        "Use a separate directory per corpus.",
    );
  }
  return state;
}

async function fetchAll(
  cfg: SyncConfig,
  wanted: readonly Readonly<{
    remote: Remote;
    base: TrackedFile | undefined;
  }>[],
): Promise<readonly Fetched[]> {
  const out: Fetched[] = [];
  for (let i = 0; i < wanted.length; i += FETCH_BATCH_SIZE) {
    const batch = wanted.slice(i, i + FETCH_BATCH_SIZE);
    out.push(
      ...(await Promise.all(
        batch.map(async ({ remote, base }) => {
          const doc = await fetchDocument(cfg, remote.slug);
          return { remote, base, doc, sha256: await sha256Hex(doc.markdown) };
        }),
      )),
    );
  }
  return out;
}

// Decide one fetched document: write it, or block it behind a local edit /
// an untracked file. Identical bytes are never a conflict.
async function decideWrite(
  f: Fetched,
  readLocal: (path: string) => Promise<Local | undefined>,
  trackedByPath: ReadonlyMap<string, TrackedFile>,
  overwrite: boolean,
): Promise<Decision> {
  const target = f.remote.path;
  const atTarget = await readLocal(target);
  const basePath = f.base?.path;
  const old = basePath === undefined ? undefined : await readLocal(basePath);
  const editedLocally =
    f.base !== undefined && old !== undefined && old.sha256 !== f.base.sha256;
  const identicalAtTarget = atTarget?.sha256 === f.sha256;

  if (
    editedLocally &&
    !overwrite &&
    !(basePath === target && identicalAtTarget)
  ) {
    return blocked(f.base, f.remote, basePath ?? target, "edited-locally");
  }
  const occupiedByOther =
    atTarget !== undefined && basePath !== target && !identicalAtTarget;
  const occupantIsTracked = occupiedByOther && trackedByPath.has(target);
  if (occupiedByOther && !occupantIsTracked && !overwrite) {
    return blocked(f.base, f.remote, target, "untracked-in-the-way");
  }
  return {
    kind: "write",
    fetched: f,
    baseWasPresent: old !== undefined,
    needsWrite: !identicalAtTarget,
    occupiedByTracked: occupantIsTracked,
  };
}

function blocked(
  entry: TrackedFile | undefined,
  remote: Remote,
  path: string,
  reason: ConflictReason,
): Blocked {
  return {
    kind: "blocked",
    entry,
    conflict: { slug: remote.slug, path, reason },
  };
}

const vacatedPath = (d: Decision): string | undefined => {
  if (d.kind === "remove") return d.entry.path;
  if (d.kind === "write" && d.fetched.base !== undefined) {
    return d.fetched.base.path === d.fetched.remote.path
      ? undefined
      : d.fetched.base.path;
  }
  return undefined;
};

// A write onto a path still held by another tracked file is only safe when
// that file is itself leaving (moved away or removed). Anything else turns
// into a conflict, which in turn keeps ITS old path occupied; iterate until
// no decision changes.
function settlePathContention(
  decisions: readonly Decision[],
): readonly Decision[] {
  let current = decisions;
  for (;;) {
    const vacated = new Set(
      current.map(vacatedPath).filter((p): p is string => p !== undefined),
    );
    const next = current.map((d): Decision => {
      if (d.kind !== "write" || !d.occupiedByTracked) return d;
      if (vacated.has(d.fetched.remote.path)) return d;
      return blocked(
        d.fetched.base,
        d.fetched.remote,
        d.fetched.remote.path,
        "path-taken",
      );
    });
    if (next.every((d, i) => d === current[i])) return next;
    current = next;
  }
}

async function apply(
  cfg: SyncConfig,
  dir: string,
  decisions: readonly Decision[],
  readLocal: (path: string) => Promise<Local | undefined>,
): Promise<void> {
  const at = (path: string): string => joinPath(dir, path);
  for (const d of decisions) {
    const gone = vacatedPath(d);
    if (gone !== undefined && (await readLocal(gone)) !== undefined) {
      await cfg.files.remove(at(gone));
    }
  }
  for (const d of decisions) {
    if (d.kind === "write" && d.needsWrite) {
      await cfg.files.writeText(
        at(d.fetched.remote.path),
        d.fetched.doc.markdown,
      );
    }
  }
}

function buildState(
  previous: SyncState,
  decisions: readonly Decision[],
): SyncState {
  const entries = decisions.flatMap((d): readonly TrackedFile[] => {
    switch (d.kind) {
      case "stay":
        return [d.entry];
      case "blocked":
        return d.entry === undefined ? [] : [d.entry];
      case "remove":
        return [];
      case "write":
        return [
          {
            path: d.fetched.remote.path,
            slug: d.fetched.remote.slug,
            docVersion: d.fetched.doc.docVersion,
            sha256: d.fetched.sha256,
          },
        ];
    }
  });
  return { ...previous, files: entries };
}

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const changeByPath = (a: SyncChange, b: SyncChange): number =>
  byPath(a.path, b.path);

function buildReport(decisions: readonly Decision[]): SyncReport {
  const added: SyncChange[] = [];
  const updated: SyncChange[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];
  const keptLocal: string[] = [];
  const conflicts: SyncConflict[] = [];
  for (const d of decisions) {
    if (d.kind === "stay") {
      (d.editedLocally ? keptLocal : unchanged).push(d.entry.path);
    } else if (d.kind === "remove") {
      removed.push(d.entry.path);
    } else if (d.kind === "blocked") {
      conflicts.push(d.conflict);
    } else {
      const { remote, base } = d.fetched;
      const moved = base !== undefined && base.path !== remote.path;
      if (!d.needsWrite && !moved) {
        unchanged.push(remote.path);
      } else {
        const change: SyncChange = moved
          ? { path: remote.path, from: base.path }
          : { path: remote.path };
        (base === undefined || !d.baseWasPresent ? added : updated).push(
          change,
        );
      }
    }
  }
  return {
    added: added.sort(changeByPath),
    updated: updated.sort(changeByPath),
    removed: removed.sort(byPath),
    unchanged: unchanged.sort(byPath),
    keptLocal: keptLocal.sort(byPath),
    conflicts: conflicts.sort((a, b) => byPath(a.path, b.path)),
  };
}

export function joinPath(dir: string, path: string): string {
  if (dir === "" || dir === ".") return path;
  return `${dir.replace(/\/+$/, "")}/${path}`;
}

const CONFLICT_REASON_TEXT: Readonly<Record<ConflictReason, string>> = {
  "edited-locally": "edited locally and changed upstream",
  "deleted-upstream": "removed upstream but edited locally",
  "untracked-in-the-way": "an untracked file is already at this path",
  "path-taken": "another tracked file still occupies this path",
};

// The report as the lines `corpus pull --all` prints. Pure, so tests assert
// on exactly what a CI log shows.
export function formatSyncReport(
  report: SyncReport,
  dir: string,
): readonly string[] {
  const changes =
    report.added.length + report.updated.length + report.removed.length;
  const lines: string[] = [];
  if (
    changes === 0 &&
    report.conflicts.length === 0 &&
    report.keptLocal.length === 0
  ) {
    return [`up to date: ${String(report.unchanged.length)} files in ${dir}`];
  }
  lines.push(
    `added ${String(report.added.length)}, updated ${String(report.updated.length)}, ` +
      `removed ${String(report.removed.length)}, unchanged ${String(report.unchanged.length)}`,
  );
  for (const c of report.added) lines.push(`+ ${c.path}`);
  for (const c of report.updated) {
    lines.push(
      c.from === undefined ? `~ ${c.path}` : `~ ${c.from} -> ${c.path}`,
    );
  }
  for (const path of report.removed) lines.push(`- ${path}`);
  if (report.keptLocal.length > 0) {
    lines.push(
      `kept ${String(report.keptLocal.length)} locally edited file(s) (upstream unchanged):`,
    );
    for (const path of report.keptLocal) lines.push(`  ${path}`);
  }
  if (report.conflicts.length > 0) {
    lines.push(
      `${String(report.conflicts.length)} conflict(s), left untouched:`,
    );
    for (const c of report.conflicts) {
      lines.push(
        `  ${c.path}  [${c.slug ?? "?"}]  (${CONFLICT_REASON_TEXT[c.reason]})`,
      );
    }
    lines.push(
      "To resolve: keep a copy of your version, run `corpus pull <slug> <path>` to take upstream's, " +
        "reapply your edit and `corpus push <slug> <path>`; or re-run with --overwrite to take " +
        "upstream's state for every file above (local edits are discarded).",
    );
  }
  return lines;
}
