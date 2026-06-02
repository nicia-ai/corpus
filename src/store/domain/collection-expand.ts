// The single, pure folder→collection resolver. Given a collection's
// ordered mix of direct-document and folder includes (one shared
// position space) plus the linked folders' subtree as plain data, it
// produces the flat, deterministic, deduplicated document order an
// agent receives. Zero-IO so it is unit-tested without a DO; every
// consumer (readCollection, the CollectionVersion snapshot, MCP, bundle
// export) routes through it so the expansion rule can never drift
// between surfaces.

export const COLLECTION_DELIVERY_VALUES = ["core", "reference"] as const;
export type CollectionDelivery = (typeof COLLECTION_DELIVERY_VALUES)[number];
export const DEFAULT_COLLECTION_DELIVERY: CollectionDelivery = "core";

export function collectionDelivery(value: unknown): CollectionDelivery {
  return value === "reference" ? "reference" : DEFAULT_COLLECTION_DELIVERY;
}

export type ExpandEntry = Readonly<
  | {
      type: "document";
      slug: string;
      position: number;
      delivery?: CollectionDelivery;
    }
  | {
      type: "folder";
      slug: string;
      position: number;
      delivery?: CollectionDelivery;
    }
>;

export type ExpandedDocument = Readonly<{
  slug: string;
  delivery: CollectionDelivery;
}>;

// A folder as plain data for the pure depth-first walk: its child
// folders (ordered by `folder_child.position`) and the documents
// directly in it (ordered here by `filename`). The repo loads this; the
// resolver never traverses the graph.
export type FolderTreeNode = Readonly<{
  slug: string;
  childFolders: readonly Readonly<{ slug: string; position: number }>[];
  documents: readonly Readonly<{ slug: string; filename: string }>[];
}>;

export type FolderTree = ReadonlyMap<string, FolderTreeNode>;

// documents-before-folders when two entries somehow share a position
// (the position space should be unique; this only makes ties stable).
function entryRank(e: ExpandEntry): number {
  return e.type === "document" ? 0 : 1;
}

function byPosition(a: ExpandEntry, b: ExpandEntry): number {
  return (
    a.position - b.position ||
    entryRank(a) - entryRank(b) ||
    a.slug.localeCompare(b.slug)
  );
}

// Depth-first PRE-order: a folder contributes its own documents (by
// `filename`) first, then recurses into child folders (by
// `folder_child.position`). First occurrence wins, so a document
// reached both directly and via a folder (or via two folders) appears
// once, at its earliest position. Cycle-guarded defensively even though
// the single-parent invariant forbids folder cycles.
export function expandCollection(
  entries: readonly ExpandEntry[],
  tree: FolderTree,
): readonly string[] {
  return expandCollectionDocuments(entries, tree).map((d) => d.slug);
}

export function expandCollectionDocuments(
  entries: readonly ExpandEntry[],
  tree: FolderTree,
): readonly ExpandedDocument[] {
  const bySlug = new Map<string, ExpandedDocument>();
  // Slugs whose winning delivery came from a *direct* membership. A
  // direct edge is the operator's explicit per-document choice, so it is
  // authoritative: a folder can never override it (and an explicit
  // direct `reference` is never silently promoted to `core` by a
  // `core`-delivered folder). Among folder-only memberships the most
  // inclusive tier (`core`) wins.
  const directLocked = new Set<string>();
  const out: ExpandedDocument[] = [];
  const replaceDelivery = (
    slug: string,
    delivery: CollectionDelivery,
  ): void => {
    const updated = { slug, delivery };
    bySlug.set(slug, updated);
    const index = out.findIndex((d) => d.slug === slug);
    if (index !== -1) out[index] = updated;
  };
  const emit = (slug: string, rawDelivery: unknown, direct: boolean): void => {
    const delivery = collectionDelivery(rawDelivery);
    const existing = bySlug.get(slug);
    // First occurrence fixes position; later occurrences only adjust the
    // delivery tier per the precedence rules above.
    if (existing === undefined) {
      const doc = { slug, delivery };
      bySlug.set(slug, doc);
      out.push(doc);
      if (direct) directLocked.add(slug);
      return;
    }
    if (direct) {
      // Direct wins. If the existing tier was folder-derived, the direct
      // edge's tier replaces it; once locked, a second direct edge can't
      // exist (one includes edge per document).
      if (!directLocked.has(slug)) {
        directLocked.add(slug);
        if (existing.delivery !== delivery) replaceDelivery(slug, delivery);
      }
      return;
    }
    // Folder-derived occurrence: it can never override a direct lock, and
    // among folder memberships core (most inclusive) wins.
    if (directLocked.has(slug)) return;
    if (existing.delivery === "reference" && delivery === "core") {
      replaceDelivery(slug, delivery);
    }
  };
  const visitFolder = (
    slug: string,
    rawDelivery: unknown,
    guard: Set<string>,
  ): void => {
    if (guard.has(slug)) return;
    guard.add(slug);
    const node = tree.get(slug);
    if (node === undefined) return;
    for (const d of [...node.documents].sort((x, y) =>
      x.filename.localeCompare(y.filename),
    )) {
      emit(d.slug, rawDelivery, false);
    }
    for (const c of [...node.childFolders].sort(
      (x, y) => x.position - y.position || x.slug.localeCompare(y.slug),
    )) {
      visitFolder(c.slug, rawDelivery, guard);
    }
  };
  for (const e of [...entries].sort(byPosition)) {
    if (e.type === "document") emit(e.slug, e.delivery, true);
    else visitFolder(e.slug, e.delivery, new Set());
  }
  return out;
}
