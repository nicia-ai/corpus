import {
  type CorpusIdentity,
  STATE_VERSION,
  type SyncState,
  type TrackedFile,
  unsafePathProblem,
} from "../../../cli/sync-state";
import { InternalError } from "../../errors";
import type { CorpusSlug, ProjectId } from "../../ids";

// The Git mirror's rules, pure and zero-IO: what a corpus's repository
// contains, what changed since its last commit, who authored it, and when to
// retry. The mirror's tree is exactly what `corpus pull --all` writes — the
// documents at their corpus-relative paths plus one `.corpus.json` — so a
// clone and a CLI checkout are interchangeable. The serialization is the
// CLI's own (`cli/sync-state.ts`), shared rather than duplicated.

export { serializeState, STATE_FILE } from "../../../cli/sync-state";

export const MIRROR_BRANCH = "main";
export const MIRROR_REF = `refs/heads/${MIRROR_BRANCH}`;

// How long a clone credential handed to an API key lives. Short on purpose:
// the CLI's credential helper mints a fresh one per `git pull`.
export const CLONE_TOKEN_TTL_SECONDS = 60 * 60;
// The write token the mirror mints for one push and revokes straight after.
// Never handed out; the service's minimum is 60 seconds.
export const PUSH_TOKEN_TTL_SECONDS = 5 * 60;

// Artifacts limits a push; past either, a single push cannot carry the corpus.
export const MAX_PUSH_BYTES = 48 * 1024 * 1024;
export const MAX_PUSH_OBJECTS = 40_000;

export const COMMITTER_NAME = "Corpus";
export const COMMITTER_EMAIL = "noreply@corpus.invalid";
export const AUTHOR_EMAIL_DOMAIN = "users.noreply.corpus.invalid";
export const SYSTEM_AUTHOR_NAME = "Corpus";

const REPO_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const EMAIL_UNSAFE_CHARACTERS = /[^A-Za-z0-9._-]/gu;
const SHA256_PREFIX = "sha256:";
const LISTED_PATH_LIMIT = 50;

// One repository per served corpus, named by the stable ids (a project id is
// a fixed-length UUID, so `<project>.<corpus>` is unambiguous). A slug can
// never contain `.`, so the name is a valid repository name.
export function mirrorRepoName(
  projectId: ProjectId,
  corpusSlug: CorpusSlug,
): string {
  const name = `${projectId}.${corpusSlug}`;
  if (!REPO_NAME_PATTERN.test(name)) {
    throw new InternalError(`not a valid mirror repository name: "${name}"`);
  }
  return name;
}

export type MirrorDocument = Readonly<{
  slug: string;
  path: string;
  docVersion: number;
  contentHash: string;
}>;

export type MirrorManifest = Readonly<{
  state: SyncState;
  // Documents left out because their path cannot be a file in a checkout.
  skipped: readonly string[];
}>;

// What `pull --all` would record for this corpus. A document whose path
// could not be written to a checkout (a `.git` segment, an escape) never
// reaches the repository.
export function mirrorManifest(
  identity: CorpusIdentity,
  documents: readonly MirrorDocument[],
): MirrorManifest {
  const files: TrackedFile[] = [];
  const skipped: string[] = [];
  for (const document of documents) {
    if (unsafePathProblem(document.path) !== undefined) {
      skipped.push(document.path);
      continue;
    }
    files.push({
      path: document.path,
      slug: document.slug,
      docVersion: document.docVersion,
      sha256: document.contentHash.startsWith(SHA256_PREFIX)
        ? document.contentHash.slice(SHA256_PREFIX.length)
        : document.contentHash,
    });
  }
  return {
    state: { version: STATE_VERSION, corpus: identity, files },
    skipped,
  };
}

export type ChangePlan = Readonly<{
  // Files to write: new paths and paths whose content changed.
  upserts: readonly TrackedFile[];
  // Paths no longer in the corpus (deleted, moved, renamed, moved out).
  removals: readonly string[];
  // Whether `.corpus.json` itself differs.
  stateChanged: boolean;
}>;

// The difference between what the mirror recorded in its last commit and
// what the corpus holds now. A path is compared by content hash alone, so a
// version bump that left the bytes identical writes no blob. With no
// previous state everything is an upsert.
export function planChange(
  previous: SyncState | undefined,
  next: SyncState,
): ChangePlan {
  const before = new Map((previous?.files ?? []).map((f) => [f.path, f]));
  const after = new Set(next.files.map((f) => f.path));
  const upserts = next.files.filter(
    (file) => before.get(file.path)?.sha256 !== file.sha256,
  );
  const removals = [...before.keys()].filter((path) => !after.has(path));
  const stateChanged =
    previous?.files.length !== next.files.length ||
    next.files.some((file) => {
      const old = before.get(file.path);
      return old?.slug !== file.slug || old.docVersion !== file.docVersion;
    });
  return { upserts, removals, stateChanged };
}

export const planIsEmpty = (plan: ChangePlan): boolean =>
  plan.upserts.length === 0 && plan.removals.length === 0 && !plan.stateChanged;

export type MirrorIdentity = Readonly<{ name: string; email: string }>;

// The person (or agent) who made the change, under a non-identifying
// address derived from their id — never a real email.
export function authorIdentity(
  changedBy: string,
  displayName: string | undefined,
): MirrorIdentity {
  const local = changedBy.replace(EMAIL_UNSAFE_CHARACTERS, "-");
  if (local === "") {
    return { name: SYSTEM_AUTHOR_NAME, email: COMMITTER_EMAIL };
  }
  return {
    name:
      displayName === undefined || displayName.trim() === ""
        ? SYSTEM_AUTHOR_NAME
        : displayName,
    email: `${local}@${AUTHOR_EMAIL_DOMAIN}`,
  };
}

export const COMMIT_SUBJECT_INITIAL = "Mirror corpus from Corpus";

// A commit message that says what changed, from the plan alone: the path
// when one file changed, a count otherwise, then every path (bounded).
export function commitMessage(plan: ChangePlan, initial: boolean): string {
  if (initial) return `${COMMIT_SUBJECT_INITIAL}\n`;
  const upserted = plan.upserts.map((file) => `update ${file.path}`);
  const removed = plan.removals.map((path) => `remove ${path}`);
  const lines = [...upserted, ...removed];
  if (lines.length === 0) return "Update corpus state\n";
  const only = plan.upserts.length + plan.removals.length === 1;
  const subject = only
    ? capitalize(lines[0] ?? "")
    : `Update ${String(lines.length)} files`;
  if (only) return `${subject}\n`;
  const listed = lines.slice(0, LISTED_PATH_LIMIT).map((line) => `- ${line}`);
  const more = lines.length - listed.length;
  const tail = more > 0 ? [`- … and ${String(more)} more`] : [];
  return `${subject}\n\n${[...listed, ...tail].join("\n")}\n`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Retry schedule for a failing sync: exponential from 30s, capped at an
// hour, and given up after MAX_SYNC_ATTEMPTS until something changes or an
// owner rebuilds.
export const RETRY_BASE_MS = 30_000;
export const RETRY_MAX_MS = 60 * 60 * 1000;
export const MAX_SYNC_ATTEMPTS = 10;

export function retryDelayMs(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(attempts - 1, 0), RETRY_MAX_MS);
}

export type EnabledMirrorStatus = Readonly<{
  enabled: true;
  state: "pending" | "synced" | "error";
  lastCommit?: string;
  lastSyncedAt?: string;
  error?: string;
}>;

export type GitMirrorStatus =
  Readonly<{ enabled: false }> | EnabledMirrorStatus;
