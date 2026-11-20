import { z } from "zod";

import { CliError } from "./errors.js";

// The sync-state file a `pull --all` checkout keeps at its root. Pure
// module: schema, deterministic serialization, hashing, path safety. All IO
// lives in `core.ts` / `sync.ts`, so this stays portable like the core.

export const STATE_FILE = ".corpus.json";
export const STATE_VERSION = 1;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const WINDOWS_DRIVE = /^[A-Za-z]:/;
const CONTROL_CHARACTERS = /\p{Cc}/u;
const FORBIDDEN_SEGMENT = ".git";

const SafePathSchema = z.string().superRefine((path, ctx) => {
  const problem = unsafePathProblem(path);
  if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
});

const TrackedFileSchema = z.object({
  path: SafePathSchema,
  slug: z.string().min(1),
  docVersion: z.number().int().nonnegative(),
  sha256: z.string().regex(SHA256_HEX),
});
// A change `push --all` filed as a proposal instead of writing it. It is NOT
// a synced file: the tracked entry keeps recording what was last pulled, so a
// later `pull --all` still sees the local edit. This only remembers what was
// already proposed, so a CI job that runs on every merge does not file the
// same proposal again. `baseVersion` is the version the proposal was filed
// against (0 for a new document); `sha256` is the proposed bytes.
const PendingProposalSchema = z.object({
  path: SafePathSchema,
  baseVersion: z.number().int().nonnegative(),
  sha256: z.string().regex(SHA256_HEX),
  proposalId: z.number().int().positive(),
});
const CorpusIdentitySchema = z.object({
  projectId: z.string().min(1),
  slug: z.string().min(1),
});
const SyncStateSchema = z.object({
  version: z.literal(STATE_VERSION),
  corpus: CorpusIdentitySchema,
  files: z.array(TrackedFileSchema),
  proposals: z.array(PendingProposalSchema).optional(),
});

export type TrackedFile = Readonly<z.infer<typeof TrackedFileSchema>>;
export type PendingProposal = Readonly<z.infer<typeof PendingProposalSchema>>;
export type CorpusIdentity = Readonly<z.infer<typeof CorpusIdentitySchema>>;
export type SyncState = Readonly<{
  version: typeof STATE_VERSION;
  corpus: CorpusIdentity;
  files: readonly TrackedFile[];
  proposals?: readonly PendingProposal[] | undefined;
}>;

export function pendingProposals(state: SyncState): readonly PendingProposal[] {
  return state.proposals ?? [];
}

// A proposal stops being pending once a tracked file at its path shows it
// was applied or overtaken: the document exists (a new-document proposal) or
// has moved past the version it was filed against.
export function stillPending(
  proposal: PendingProposal,
  files: readonly TrackedFile[],
): boolean {
  const tracked = files.find((f) => f.path === proposal.path);
  if (tracked === undefined) return true;
  return proposal.baseVersion > 0 && tracked.docVersion <= proposal.baseVersion;
}

// Why a corpus-relative path may not be materialized, or `undefined` when it
// is safe. A document path comes from the server and a tracked path from a
// file in the working tree: both are untrusted input to a filesystem write
// or delete, so neither may escape the checkout root or touch `.git`.
export function unsafePathProblem(path: string): string | undefined {
  if (path === "") return "empty path";
  if (path.startsWith("/") || WINDOWS_DRIVE.test(path)) {
    return "absolute path";
  }
  if (path.includes("\\")) return "backslash in path";
  if (CONTROL_CHARACTERS.test(path)) return "control character in path";
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    return "empty, '.' or '..' segment";
  }
  if (segments.some((s) => s.toLowerCase() === FORBIDDEN_SEGMENT)) {
    return `'${FORBIDDEN_SEGMENT}' segment`;
  }
  if (path.toLowerCase() === STATE_FILE) {
    return `reserved for ${STATE_FILE}`;
  }
  return undefined;
}

// Two paths a case-insensitive or normalizing filesystem would store as one.
export function collisionKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

export function emptyState(corpus: CorpusIdentity): SyncState {
  return { version: STATE_VERSION, corpus, files: [] };
}

export function sameCorpus(a: CorpusIdentity, b: CorpusIdentity): boolean {
  return a.projectId === b.projectId && a.slug === b.slug;
}

export function parseState(raw: string, location: string): SyncState {
  try {
    return SyncStateSchema.parse(JSON.parse(raw));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliError(
      "state",
      `${location} is not a valid Corpus sync-state file (format version ${String(STATE_VERSION)}): ${reason}`,
    );
  }
}

const compareCodePoints = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

// Stable key order, files sorted by path, trailing newline: committing the
// file yields minimal diffs and re-serializing identical state is a no-op.
export function serializeState(state: SyncState): string {
  const files = [...state.files]
    .sort((a, b) => compareCodePoints(a.path, b.path))
    .map((f) => ({
      path: f.path,
      slug: f.slug,
      docVersion: f.docVersion,
      sha256: f.sha256,
    }));
  const proposals = pendingProposals(state)
    .filter((p) => stillPending(p, state.files))
    .sort((a, b) => compareCodePoints(a.path, b.path))
    .map((p) => ({
      path: p.path,
      baseVersion: p.baseVersion,
      sha256: p.sha256,
      proposalId: p.proposalId,
    }));
  const ordered = {
    version: state.version,
    corpus: {
      projectId: state.corpus.projectId,
      slug: state.corpus.slug,
    },
    files,
    ...(proposals.length === 0 ? {} : { proposals }),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export type StateCandidate = Readonly<{ statePath: string; relPath: string }>;

// Every place a state file could govern `file`, nearest first: each ancestor
// directory's `.corpus.json`, with `file`'s path relative to it. Textual, so
// it needs no path library; an absolute path stops above its root segment.
export function stateCandidates(file: string): readonly StateCandidate[] {
  const segments = file.split("/");
  const absolute = file.startsWith("/") || WINDOWS_DRIVE.test(file);
  const lowest = absolute ? 1 : 0;
  const candidates: StateCandidate[] = [];
  for (let depth = segments.length - 1; depth >= lowest; depth -= 1) {
    candidates.push({
      statePath: [...segments.slice(0, depth), STATE_FILE].join("/"),
      relPath: segments.slice(depth).join("/"),
    });
  }
  return candidates;
}
