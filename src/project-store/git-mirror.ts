import type { SyncState, TrackedAsset } from "../../cli/sync-state";
import type { MirrorStateRow } from "../db";
import { InternalError } from "../errors";
import { asCorpusSlug, type CorpusSlug, type ProjectId } from "../ids";
import { MirrorServiceError } from "../mirror/errors";
import type { GitMirror, MirrorHead } from "../mirror/port";
import { corpusIsServed } from "../store/domain/corpus-drive";
import type { Bytes } from "../store/domain/git/objects";
import type { FileWrite } from "../store/domain/git/tree-edit";
import {
  authorIdentity,
  type ChangePlan,
  chunkPlan,
  CLONE_TOKEN_TTL_SECONDS,
  commitMessage,
  COMMITTER_EMAIL,
  COMMITTER_NAME,
  type EnabledMirrorStatus,
  type GitMirrorStatus,
  MIRROR_CHUNK_BYTES,
  mirrorManifest,
  type MirrorManifest,
  mirrorRepoName,
  planChange,
  planIsEmpty,
  retryDelayMs,
  serializeState,
  STATE_FILE,
} from "../store/domain/git-mirror";
import { fileObjectKey, type ObjectStore } from "../store/repos/object-store";
import { sha256Hex } from "../util";

import { isDocumentChange, isFileChange, type DomainChange } from "./command";
import {
  corpusOfDocument,
  corpusOfEveryDocument,
} from "./commands/corpus-tree";
import { listFilesProjection, resolvedViews } from "./queries";
import type { ProjectUnit } from "./unit";

// The application side of the Git mirror: records, inside the same write
// transaction as a change, that a corpus's repository is now behind; and
// drains that record afterwards by pushing the difference through the
// `GitMirror` port. The network push is never inside a transaction, and a
// failure never reaches the save that caused it — it only earns a retry.

type MirrorDeps = Readonly<{
  // `undefined` = the Artifacts binding is not configured: the mirror is off.
  port: () => GitMirror | undefined;
  projectId: () => ProjectId;
  read: () => Promise<ProjectUnit>;
  write: <T>(fn: (u: ProjectUnit) => Promise<T>) => Promise<T>;
  // Ask for the DO alarm at (or before) this epoch-millisecond time.
  scheduleAlarm: (atMs: number) => Promise<void>;
  authorName: (changedBy: string) => Promise<string | undefined>;
  // The bytes of uploaded files; `undefined` = no file storage configured.
  objects: () => ObjectStore | undefined;
  now: () => number;
}>;

// Passes that find the branch moved under them before giving up for a retry
// later (each pass re-reads the head, so a lost race is cheap).
const MAX_STALE_RETRIES = 3;
// Commits one pass may make while a large change goes out in pieces. The
// project's file quota splits into well under this many, so reaching it means
// the plan is not shrinking (a head whose state this version cannot read) and
// the pass gives up for a retry rather than pushing forever.
const MAX_PASS_COMMITS = 100;
// A command that touches more documents than this (a folder move, a bundle
// import) finds their corpora in one project-wide read instead of one lookup
// each — inside the write transaction, where every statement counts.
const BULK_LOOKUP_THRESHOLD = 16;
const ERROR_TEXT_LIMIT = 500;
const MS_PER_SECOND = 1000;
const SYSTEM_AUTHOR = "";

// Test seam (module-level, like `setGitMirrorForTest`): the DO runs in the
// tests' isolate, so a test can shrink the per-commit budget to watch a small
// corpus split into several commits. Never set in production.
let chunkBytesOverride: number | undefined;

export function setMirrorChunkBytesForTest(bytes: number | undefined): void {
  chunkBytesOverride = bytes;
}

type CorpusNow = Readonly<{
  manifest: MirrorManifest;
  hashByPath: ReadonlyMap<string, string>;
}>;

export type CloneAccessResult = Readonly<
  | {
      ok: true;
      remote: string;
      token: string;
      expiresAt: string;
      // False while the mirror is behind or failing: the clone is real but
      // not current.
      current: boolean;
    }
  | { ok: false; reason: "not-enabled" | "not-found" | "not-ready" }
>;

export type RebuildResult = Readonly<
  { ok: true } | { ok: false; reason: "not-enabled" | "not-found" }
>;

export class ProjectGitMirror {
  private drainPromise: Promise<void> | undefined;
  private rerunRequested = false;

  constructor(private readonly deps: MirrorDeps) {}

  get enabled(): boolean {
    return this.deps.port() !== undefined && this.deps.projectId() !== "";
  }

  // — Inside the write transaction ————————————————————————————————

  // Note which corpora this command left behind their repositories. Runs in
  // the command's own transaction, so the record and the change commit or
  // roll back together. Returns whether anything was recorded (the caller
  // then wakes the drain, after the commit).
  async record(
    u: ProjectUnit,
    changes: readonly DomainChange[],
    snapshotted: ReadonlySet<CorpusSlug>,
  ): Promise<boolean> {
    if (!this.enabled) return false;
    const touched = new Map<CorpusSlug, "sync" | "delete">();
    const authors = new Map<
      CorpusSlug,
      { changedBy: string; changedAt: string }
    >();
    const note = (
      corpusSlug: CorpusSlug,
      what: "sync" | "delete",
      change: DomainChange,
    ): void => {
      // A corpus deleted by this command stays deleted, whatever else the
      // command did to its documents.
      touched.set(
        corpusSlug,
        touched.get(corpusSlug) === "delete" ? "delete" : what,
      );
      authors.set(corpusSlug, {
        changedBy: change.changedBy,
        changedAt: change.changedAt,
      });
    };
    const bulk =
      changes.filter(isDocumentChange).length > BULK_LOOKUP_THRESHOLD
        ? await corpusOfEveryDocument(u)
        : undefined;
    for (const change of changes) {
      if (isFileChange(change)) {
        note(change.corpusSlug, "sync", change);
        // A file moved between corpora leaves the one it came from behind too.
        if (
          change.fromCorpusSlug !== undefined &&
          change.fromCorpusSlug !== change.corpusSlug
        ) {
          note(change.fromCorpusSlug, "sync", change);
        }
        continue;
      }
      if (isDocumentChange(change)) {
        const corpusSlug =
          bulk === undefined
            ? await corpusOfDocument(u, change.slug)
            : bulk.get(change.slug);
        if (corpusSlug !== undefined) note(corpusSlug, "sync", change);
      } else {
        note(
          change.collectionSlug,
          change.kind === "collection.deleted" ? "delete" : "sync",
          change,
        );
      }
    }
    const fallback = changes.at(-1);
    for (const corpusSlug of snapshotted) {
      if (!touched.has(corpusSlug) && fallback !== undefined) {
        note(corpusSlug, "sync", fallback);
      }
    }
    let recorded = false;
    for (const [corpusSlug, what] of touched) {
      const author = authors.get(corpusSlug);
      if (author === undefined) continue;
      if (what === "delete") {
        await u.mirror.requestDelete(corpusSlug, author);
        recorded = true;
      } else if (corpusIsServed(corpusSlug)) {
        await u.mirror.recordChange(corpusSlug, author);
        recorded = true;
      }
    }
    return recorded;
  }

  // After the commit: have the alarm run a pass now. Best effort — a save
  // must never fail because the alarm could not be set; the next change (or
  // an owner rebuild) wakes the drain again.
  async wake(): Promise<void> {
    try {
      await this.deps.scheduleAlarm(this.deps.now());
    } catch (error) {
      console.error("[git-mirror] could not schedule the drain", error);
    }
  }

  // — Reads and owner actions ——————————————————————————————————————

  // The mirror's state for one corpus. The first look at a served corpus
  // that has no record yet starts its mirror, so enabling the binding on a
  // project with existing content needs no migration step.
  async status(corpusSlug: CorpusSlug): Promise<GitMirrorStatus> {
    if (!this.enabled || !corpusIsServed(corpusSlug)) return { enabled: false };
    let row = await (await this.deps.read()).mirror.find(corpusSlug);
    if (row === undefined) {
      const enrolled = await this.enroll(corpusSlug, SYSTEM_AUTHOR);
      if (!enrolled) return { enabled: false };
      row = await (await this.deps.read()).mirror.find(corpusSlug);
    }
    return row === undefined ? { enabled: false } : statusOf(row);
  }

  // Start mirroring a served corpus that has no record yet. `false` when
  // there is no such corpus.
  private async enroll(
    corpusSlug: CorpusSlug,
    changedBy: string,
  ): Promise<boolean> {
    const changedAt = new Date(this.deps.now()).toISOString();
    const exists = await this.deps.write(async (u) => {
      if ((await resolvedViews(u, corpusSlug)) === undefined) return false;
      await u.mirror.recordChange(corpusSlug, { changedBy, changedAt });
      return true;
    });
    if (exists) await this.wake();
    return exists;
  }

  async rebuild(
    corpusSlug: CorpusSlug,
    changedBy: string,
  ): Promise<RebuildResult> {
    if (!this.enabled) return { ok: false, reason: "not-enabled" };
    const changedAt = new Date(this.deps.now()).toISOString();
    const exists = await this.deps.write(async (u) => {
      if ((await resolvedViews(u, corpusSlug)) === undefined) return false;
      await u.mirror.requestRebuild(corpusSlug, { changedBy, changedAt });
      return true;
    });
    if (!exists || !corpusIsServed(corpusSlug)) {
      return { ok: false, reason: "not-found" };
    }
    await this.wake();
    return { ok: true };
  }

  async cloneAccess(corpusSlug: CorpusSlug): Promise<CloneAccessResult> {
    const port = this.deps.port();
    if (port === undefined || !this.enabled) {
      return { ok: false, reason: "not-enabled" };
    }
    if (!corpusIsServed(corpusSlug)) return { ok: false, reason: "not-found" };
    const row = await (await this.deps.read()).mirror.find(corpusSlug);
    if (row?.lastCommit == null) {
      // Nothing has been pushed yet: start (or keep) the mirror going.
      await this.status(corpusSlug);
      return { ok: false, reason: "not-ready" };
    }
    const access = await port.cloneAccess(
      mirrorRepoName(this.deps.projectId(), corpusSlug),
      CLONE_TOKEN_TTL_SECONDS,
    );
    return { ok: true, ...access, current: statusOf(row).state === "synced" };
  }

  // The project is being torn down: its repositories go too, best effort.
  async discardAll(): Promise<void> {
    const port = this.deps.port();
    if (port === undefined || !this.enabled) return;
    const rows = await (await this.deps.read()).mirror.all();
    for (const row of rows) {
      try {
        await port.discard(
          mirrorRepoName(this.deps.projectId(), asCorpusSlug(row.corpusSlug)),
        );
      } catch (error) {
        console.error("[git-mirror] could not delete a repository", error);
      }
    }
  }

  // — The drain ————————————————————————————————————————————————————

  async drain(): Promise<void> {
    if (!this.enabled) return;
    if (this.drainPromise !== undefined) {
      // A change landed while a pass was running: that pass may already have
      // read its rows, so ask it to look again rather than wait for an alarm.
      this.rerunRequested = true;
      return this.drainPromise;
    }
    this.drainPromise = this.drainLoop().finally(() => {
      this.drainPromise = undefined;
    });
    return this.drainPromise;
  }

  private async drainLoop(): Promise<void> {
    for (;;) {
      const due = await (await this.deps.read()).mirror.dueAt(this.deps.now());
      for (const row of due) await this.pass(row);
      // Rows were worked: look again, for changes that landed meanwhile.
      // Nothing due: stop, unless a write asked for another pass.
      if (due.length === 0 && !this.consumeRerun()) break;
    }
    const next = await (
      await this.deps.read()
    ).mirror.nextRetryAfter(this.deps.now());
    if (next !== undefined) await this.deps.scheduleAlarm(next);
  }

  private consumeRerun(): boolean {
    const requested = this.rerunRequested;
    this.rerunRequested = false;
    return requested;
  }

  // One corpus, one attempt. Whatever happens, the row ends up either synced,
  // deleted, or marked failed with a time to try again: a pass never leaves a
  // row looking due and untouched, which would spin the loop.
  private async pass(row: MirrorStateRow): Promise<void> {
    const corpusSlug = asCorpusSlug(row.corpusSlug);
    try {
      await this.attempt(row, corpusSlug);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[git-mirror] ${row.corpusSlug}: ${message}`);
      const retryAt = this.deps.now() + retryDelayMs(row.attempts + 1);
      await this.deps.write((u) =>
        u.mirror.markFailed(corpusSlug, {
          error: message.slice(0, ERROR_TEXT_LIMIT),
          retryAt,
        }),
      );
    }
  }

  private async attempt(
    row: MirrorStateRow,
    corpusSlug: CorpusSlug,
  ): Promise<void> {
    const port = this.deps.port();
    if (port === undefined) return;
    const repo = mirrorRepoName(this.deps.projectId(), corpusSlug);
    if (row.intent === "delete") return this.removeRepo(port, repo, row);

    let presence = await port.inspect(repo);
    if (row.intent === "rebuild") {
      await port.discard(repo);
      await this.deps.write((u) => u.mirror.consumeRebuild(corpusSlug));
      presence = { kind: "missing" };
    }

    // The last commit this project is known to have pushed: it advances as a
    // large change goes out in several commits.
    let lastCommit = row.lastCommit;
    let lostRaces = 0;
    let commits = 0;
    for (;;) {
      const now = await this.corpusNow(corpusSlug);
      // The corpus is gone: its repository goes with it.
      if (now === undefined) return this.removeRepo(port, repo, row);

      if (presence.kind === "missing") {
        await port.create(repo);
        presence = { kind: "empty" };
      }
      let head = presence.kind === "head" ? presence.head : undefined;
      if (head !== undefined && !isExpected(head, lastCommit)) {
        console.warn(
          `[git-mirror] ${row.corpusSlug}: repository head is not the one this project pushed; rebuilding`,
        );
        await port.discard(repo);
        await port.create(repo);
        head = undefined;
      }

      const plan = planChange(head?.state, now.manifest.state);
      if (head !== undefined && planIsEmpty(plan)) {
        return this.synced(corpusSlug, row, head.commit);
      }
      // One commit per loop: the rest of a split plan is re-planned from the
      // repository's new head, so a failure or a concurrent change between
      // commits never leaves a stale plan to finish.
      const [chunk, ...rest] = chunkPlan(
        head?.state,
        now.manifest.state,
        plan,
        chunkBytesOverride ?? MIRROR_CHUNK_BYTES,
      );
      if (chunk === undefined) {
        throw new InternalError("a non-empty mirror plan produced no commit");
      }
      const writes = await this.contentOf(corpusSlug, chunk.plan, now);
      const outcome = await port.commit({
        repo,
        base: head,
        edit: {
          writes: [...writes, stateFile(chunk.state)],
          removals: chunk.plan.removals,
        },
        author: await this.author(row),
        committer: {
          name: COMMITTER_NAME,
          email: COMMITTER_EMAIL,
          when: Math.floor(this.deps.now() / MS_PER_SECOND),
        },
        message: commitMessage(chunk.plan, head === undefined),
      });
      if (outcome.kind === "pushed" && rest.length === 0) {
        return this.synced(corpusSlug, row, outcome.commit);
      }
      if (outcome.kind === "pushed") {
        commits += 1;
        if (commits >= MAX_PASS_COMMITS) {
          throw new MirrorServiceError(
            "the mirror's change did not shrink after many commits; will retry",
          );
        }
        lastCommit = outcome.commit;
        await this.deps.write((u) =>
          u.mirror.recordPushed(corpusSlug, outcome.commit),
        );
      } else {
        lostRaces += 1;
        if (lostRaces > MAX_STALE_RETRIES) {
          throw new MirrorServiceError(
            "the repository branch kept moving while pushing; will retry",
          );
        }
      }
      presence = await port.inspect(repo);
    }
  }

  private async removeRepo(
    port: GitMirror,
    repo: string,
    row: MirrorStateRow,
  ): Promise<void> {
    await port.discard(repo);
    await this.deps.write((u) =>
      u.mirror.deleteIfUnchanged(asCorpusSlug(row.corpusSlug), row.generation),
    );
  }

  // What the corpus holds now, or `undefined` when it no longer exists.
  private async corpusNow(
    corpusSlug: CorpusSlug,
  ): Promise<CorpusNow | undefined> {
    const u = await this.deps.read();
    const views = await resolvedViews(u, corpusSlug);
    if (views === undefined) return undefined;
    const files = (await listFilesProjection(u))
      .filter((file) => file.corpusSlug === corpusSlug)
      .map((file) => ({
        slug: file.slug,
        path: file.path,
        contentHash: file.contentHash,
        size: file.size,
      }));
    const manifest = mirrorManifest(
      { projectId: this.deps.projectId(), slug: corpusSlug },
      views,
      files,
    );
    if (manifest.skipped.length > 0) {
      console.warn(
        `[git-mirror] ${corpusSlug}: ${String(manifest.skipped.length)} document(s) or file(s) not mirrored: their paths cannot be files in a checkout, or a file is over the size cap`,
      );
    }
    return {
      manifest,
      hashByPath: new Map(views.map((v) => [v.path, v.contentHash])),
    };
  }

  // The bytes of the files one commit writes: one batched blob read for just
  // those documents, however large the corpus is, then the images and
  // attachments, fetched from file storage one at a time.
  private async contentOf(
    corpusSlug: CorpusSlug,
    plan: ChangePlan,
    now: CorpusNow,
  ): Promise<readonly FileWrite[]> {
    const { upserts } = plan;
    const hashes = upserts.map((f) => now.hashByPath.get(f.path) ?? "");
    const u = await this.deps.read();
    const markdown = await u.blobs.getMany(hashes);
    const encoder = new TextEncoder();
    const documents = upserts.map((file) => {
      const body = markdown.get(now.hashByPath.get(file.path) ?? "");
      if (body === undefined) {
        throw new MirrorServiceError(
          `${corpusSlug}: the stored bytes of ${file.path} are missing`,
        );
      }
      return { path: file.path, content: encoder.encode(body) };
    });
    return [...documents, ...(await this.assetContent(corpusSlug, plan))];
  }

  // Each file's bytes are read whole, checked against the hash and size the
  // project recorded, and only then handed on: a mirror never commits bytes
  // the graph does not vouch for.
  private async assetContent(
    corpusSlug: CorpusSlug,
    plan: ChangePlan,
  ): Promise<readonly FileWrite[]> {
    if (plan.assetUpserts.length === 0) return [];
    const objects = this.deps.objects();
    if (objects === undefined) {
      throw new MirrorServiceError(
        `${corpusSlug}: this corpus has images or attachments but the deployment has no file storage (the FILES binding) to read them from`,
      );
    }
    const writes: FileWrite[] = [];
    for (const asset of plan.assetUpserts) {
      writes.push({
        path: asset.path,
        content: await this.assetBytes(objects, corpusSlug, asset),
      });
    }
    return writes;
  }

  private async assetBytes(
    objects: ObjectStore,
    corpusSlug: CorpusSlug,
    asset: TrackedAsset,
  ): Promise<Bytes> {
    const object = await objects.get(
      fileObjectKey(this.deps.projectId(), asset.sha256),
    );
    if (object === undefined) {
      throw new MirrorServiceError(
        `${corpusSlug}: the stored bytes of ${asset.path} are missing`,
      );
    }
    const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
    if (
      bytes.byteLength !== asset.size ||
      (await sha256Hex(bytes)) !== asset.sha256
    ) {
      throw new MirrorServiceError(
        `${corpusSlug}: the stored bytes of ${asset.path} do not match the recorded hash`,
      );
    }
    return bytes;
  }

  private async author(row: MirrorStateRow): Promise<{
    name: string;
    email: string;
    when: number;
  }> {
    const identity = authorIdentity(
      row.changedBy,
      await this.deps.authorName(row.changedBy),
    );
    const changedAt = Date.parse(row.changedAt);
    return {
      ...identity,
      when: Math.floor(
        (Number.isNaN(changedAt) ? this.deps.now() : changedAt) / MS_PER_SECOND,
      ),
    };
  }

  private async synced(
    corpusSlug: CorpusSlug,
    row: MirrorStateRow,
    commit: string,
  ): Promise<void> {
    await this.deps.write((u) =>
      u.mirror.markSynced(corpusSlug, {
        generation: row.generation,
        commit,
        at: new Date(this.deps.now()).toISOString(),
      }),
    );
  }
}

function stateFile(state: SyncState): FileWrite {
  const content: Bytes = new TextEncoder().encode(serializeState(state));
  return { path: STATE_FILE, content };
}

// The repository's head is the one this project last pushed — or the commit
// right after it, which is what remains when a push landed but the record of
// it did not (a crash between the two). Anything else means someone or
// something else has written to the repository: start over.
function isExpected(head: MirrorHead, lastCommit: string | null): boolean {
  if (lastCommit === null) return false;
  return head.commit === lastCommit || head.parents[0] === lastCommit;
}

function statusOf(row: MirrorStateRow): EnabledMirrorStatus {
  const pending =
    row.generation > row.syncedGeneration || row.intent !== "sync";
  const commit = row.lastCommit === null ? {} : { lastCommit: row.lastCommit };
  const at =
    row.lastSyncedAt === null ? {} : { lastSyncedAt: row.lastSyncedAt };
  if (row.lastError !== null) {
    return {
      enabled: true,
      state: "error",
      error: row.lastError,
      ...commit,
      ...at,
    };
  }
  const state = pending || row.lastCommit === null ? "pending" : "synced";
  return { enabled: true, state, ...commit, ...at };
}
