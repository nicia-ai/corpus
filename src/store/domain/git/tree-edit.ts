import { InternalError } from "../../../errors";

import {
  blobObject,
  type Bytes,
  DIRECTORY_MODE,
  FILE_MODE,
  type GitObject,
  type TreeEntry,
  treeObject,
} from "./objects";

// Turn "these files changed" into the new git tree objects, touching only
// the directories on the changed paths. Reading an existing tree is the
// caller's seam (`TreeReader`), so this stays pure and a one-file change
// costs one read per directory on its path, not one per file in the corpus.

export type FileWrite = Readonly<{ path: string; content: Bytes }>;

export type TreeEdit = Readonly<{
  writes: readonly FileWrite[];
  removals: readonly string[];
}>;

// The immediate children of a tree, or `undefined` when it does not exist.
export type TreeReader = (
  sha: string,
) => Promise<readonly TreeEntry[] | undefined>;

export type EditedTree = Readonly<{
  // `undefined` when the edit leaves the tree empty (git stores no empty
  // trees).
  root: string | undefined;
  // New objects the receiver does not yet have, each exactly once.
  objects: readonly GitObject[];
}>;

// The edit as a trie: per directory, the files it writes or removes (a
// removal is `null`) and the subdirectories it reaches into.
type Trie = Readonly<{
  files: Map<string, Bytes | null>;
  dirs: Map<string, Trie>;
}>;

const newTrie = (): Trie => ({ files: new Map(), dirs: new Map() });

function insert(root: Trie, path: string, content: Bytes | null): void {
  const segments = path.split("/");
  const name = segments.pop();
  if (name === undefined || name === "" || segments.some((s) => s === "")) {
    throw new InternalError(`invalid mirror path: "${path}"`);
  }
  let node = root;
  for (const segment of segments) {
    let next = node.dirs.get(segment);
    if (next === undefined) {
      next = newTrie();
      node.dirs.set(segment, next);
    }
    node = next;
  }
  node.files.set(name, content);
}

function trieOf(edit: TreeEdit): Trie {
  const root = newTrie();
  for (const path of edit.removals) insert(root, path, null);
  for (const write of edit.writes) insert(root, write.path, write.content);
  return root;
}

async function applyToTree(
  read: TreeReader,
  base: string | undefined,
  trie: Trie,
  collected: Map<string, GitObject>,
): Promise<string | undefined> {
  const existing =
    base === undefined ? [] : ((await read(base)) ?? missingTree(base));
  const entries = new Map(existing.map((entry) => [entry.name, entry]));

  // Directories first: a name that stops being a directory and becomes a
  // file (or the reverse) within one edit then resolves to the file.
  for (const [name, child] of trie.dirs) {
    const current = entries.get(name);
    const childBase =
      current?.mode === DIRECTORY_MODE ? current.sha : undefined;
    const sha = await applyToTree(read, childBase, child, collected);
    if (sha === undefined) entries.delete(name);
    else entries.set(name, { mode: DIRECTORY_MODE, name, sha });
  }

  for (const [name, content] of trie.files) {
    if (content === null) {
      // Removing a file that a directory of the same name replaces.
      if (!trie.dirs.has(name)) entries.delete(name);
      continue;
    }
    if (entries.get(name)?.mode === DIRECTORY_MODE && trie.dirs.has(name)) {
      throw new InternalError(`"${name}" is both a file and a directory`);
    }
    const blob = await blobObject(content);
    collected.set(blob.sha, blob);
    entries.set(name, { mode: FILE_MODE, name, sha: blob.sha });
  }

  if (entries.size === 0) return undefined;
  const tree = await treeObject([...entries.values()]);
  const unchanged = base === tree.sha;
  if (!unchanged) collected.set(tree.sha, tree);
  return tree.sha;
}

function missingTree(sha: string): never {
  throw new InternalError(`tree ${sha} is missing from the repository`);
}

// Apply `edit` to the tree `base` (`undefined` = start from nothing).
export async function editTree(
  read: TreeReader,
  base: string | undefined,
  edit: TreeEdit,
): Promise<EditedTree> {
  const collected = new Map<string, GitObject>();
  const root = await applyToTree(read, base, trieOf(edit), collected);
  return { root, objects: [...collected.values()] };
}

const NO_TREES: TreeReader = () => Promise.resolve(undefined);

// A whole tree from nothing — the first commit, or a rebuild.
export function buildTree(writes: readonly FileWrite[]): Promise<EditedTree> {
  return editTree(NO_TREES, undefined, { writes, removals: [] });
}
