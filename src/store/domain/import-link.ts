import type { FolderSlug } from "../../ids";

// Pure, zero-IO rule for what an upload links to a collection. The DO
// derives it from ground truth observed during import — never from a
// client-supplied flag — which is what makes the folder-vs-documents
// choice un-forgeable. Unit-tested without a DO (test/import-link.test.ts).

export type ImportLinkTarget = Readonly<
  { kind: "folder"; folderSlug: FolderSlug } | { kind: "documents" }
>;

// Choose the link target from each imported document's folder ancestry
// (root→leaf folder slugs; `[]` = project root) and the set of folders
// THIS import created. Link the fresh wrapper — the topmost folder the
// import created that is a common ancestor of every imported document —
// so documents added to it later join the collection (the live link).
// Its subtree is entirely this import's (it did not exist before), so
// linking it never exposes pre-existing content. When there is no such
// fresh common folder (a root upload, or a merge into a folder that
// already existed), link the documents themselves.
export function chooseImportLinkTarget(
  folderChains: readonly (readonly FolderSlug[])[],
  createdFolderSlugs: ReadonlySet<FolderSlug>,
): ImportLinkTarget {
  if (folderChains.length === 0) return { kind: "documents" };
  for (const slug of commonPrefix(folderChains)) {
    if (createdFolderSlugs.has(slug)) {
      return { kind: "folder", folderSlug: slug };
    }
  }
  return { kind: "documents" };
}

// Longest common prefix of the folder chains, root→leaf.
function commonPrefix(
  chains: readonly (readonly FolderSlug[])[],
): readonly FolderSlug[] {
  const [first, ...rest] = chains;
  if (first === undefined) return [];
  let end = first.length;
  for (const chain of rest) {
    end = Math.min(end, chain.length);
    for (let i = 0; i < end; i += 1) {
      if (chain[i] !== first[i]) {
        end = i;
        break;
      }
    }
  }
  return first.slice(0, end);
}
