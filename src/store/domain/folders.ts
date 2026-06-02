// Pure, zero-IO folder-tree rules. The repo loads the tree and calls
// these to decide; no DB access here. Unit-tested without a DO
// (test/folders.test.ts). `null` parent = project root throughout.

export type SiblingKind = "folder" | "document";

// One child as it competes in its parent's single namespace. A
// document's segment is its `filename`; a folder's is its `name`. The
// namespace is cross-type: a folder and a document cannot share a
// segment under the same parent, or relative-link path resolution is
// ambiguous. `kind` is required because folder slugs and document slugs
// are INDEPENDENT namespaces (separate TypeGraph unique scopes) and may
// coincide as strings — self-identity must be (kind, slug), never slug
// alone, or a same-slug sibling of the other kind is wrongly excluded.
export type SiblingSegment = Readonly<{
  kind: SiblingKind;
  slug: string;
  segment: string;
}>;

export type SiblingSelf = Readonly<{ kind: SiblingKind; slug: string }>;

// Does `candidate` collide with an existing sibling segment? Exact
// match (binary collation, mirroring the graph's unique constraints).
// `self` excludes ONLY the same entity (same kind AND slug) — a
// rename/move/re-place in place — never a same-slug node of the other
// kind.
export function segmentCollides(
  siblings: readonly SiblingSegment[],
  candidate: string,
  self?: SiblingSelf,
): boolean {
  return siblings.some(
    (s) =>
      s.segment === candidate &&
      !(s.kind === self?.kind && s.slug === self.slug),
  );
}

// Walk parent links from `nodeSlug` upward; true if `ancestorSlug` is
// `nodeSlug` itself or any of its ancestors. `parentOf` maps a folder
// slug to its parent slug (or null at root); a missing key terminates
// the walk (treated as root).
export function isSelfOrAncestor(
  ancestorSlug: string,
  nodeSlug: string,
  parentOf: ReadonlyMap<string, string | null>,
): boolean {
  let cursor: string | null = nodeSlug;
  const seen = new Set<string>();
  while (cursor !== null && !seen.has(cursor)) {
    if (cursor === ancestorSlug) return true;
    seen.add(cursor);
    cursor = parentOf.get(cursor) ?? null;
  }
  return false;
}

// Moving `folderSlug` under `newParentSlug` is illegal when the new
// parent is the folder itself or one of its descendants (it would
// detach a cycle from the tree). `newParentSlug === null` (→ root) is
// always safe.
export function wouldCreateCycle(
  folderSlug: string,
  newParentSlug: string | null,
  parentOf: ReadonlyMap<string, string | null>,
): boolean {
  if (newParentSlug === null) return false;
  return isSelfOrAncestor(folderSlug, newParentSlug, parentOf);
}

// The position a new last child takes in a parent's sibling order
// (1-based, contiguous). `existing` is the current sibling positions.
export function appendPosition(existing: readonly number[]): number {
  return existing.reduce((max, p) => Math.max(max, p), 0) + 1;
}
