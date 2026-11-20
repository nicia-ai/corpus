import type { SyncState } from "../../cli/sync-state";
import type { Signature } from "../store/domain/git/objects";
import type { TreeEdit } from "../store/domain/git/tree-edit";

// The narrow port between the ProjectStore and wherever a corpus's Git
// repository lives: "push these changes to this corpus's repository". The DO
// depends on this, never on Artifacts, so tests can stand in for it and a
// different host is one new adapter. Repositories are addressed by name.

// What the repository's branch points at.
export type MirrorHead = Readonly<{
  commit: string;
  treeHash: string;
  parents: readonly string[];
  // `.corpus.json` as committed there; `undefined` when it is absent or not
  // a state file this version of Corpus wrote.
  state: SyncState | undefined;
}>;

export type RepoPresence = Readonly<
  | { kind: "missing" }
  // The repository exists but has no commit on the branch.
  | { kind: "empty" }
  | { kind: "head"; head: MirrorHead }
>;

export type CommitRequest = Readonly<{
  repo: string;
  // The head the edit applies to; `undefined` for a first commit.
  base: MirrorHead | undefined;
  edit: TreeEdit;
  author: Signature;
  committer: Signature;
  message: string;
}>;

export type CommitOutcome = Readonly<
  | { kind: "pushed"; commit: string; objects: number; bytes: number }
  // The branch moved since `base` was read; re-read and try again.
  | { kind: "stale" }
>;

export type CloneAccess = Readonly<{
  remote: string;
  // A read-scoped credential: the full token string.
  token: string;
  expiresAt: string;
}>;

export type GitMirror = Readonly<{
  inspect: (repo: string) => Promise<RepoPresence>;
  // Create the repository; succeeds when it already exists.
  create: (repo: string) => Promise<void>;
  commit: (request: CommitRequest) => Promise<CommitOutcome>;
  // Delete the repository; succeeds when it is already gone.
  discard: (repo: string) => Promise<void>;
  // Mint a read-only credential. Never a write credential.
  cloneAccess: (repo: string, ttlSeconds: number) => Promise<CloneAccess>;
}>;
