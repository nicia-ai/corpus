import { z } from "zod";

import type { CollectionSlug, DocumentSlug, FolderSlug } from "../../ids";
import { alwaysIncludeBudgetTokensZ, compact } from "../../util";

import type { CollectionDelivery } from "./collection-expand";

// The change-event vocabulary — the single source of event-type
// strings, so callers stay typed instead of hand-building literals.
export type DocumentEventType =
  | "document.created"
  | "document.updated"
  | "document.renamed"
  | "document.filename_changed"
  | "document.archived";

export type CollectionEventType =
  | "collection.created"
  | "collection.updated"
  | "collection.attached"
  | "collection.detached"
  | "collection.reordered";

export type DocumentChange = Readonly<{
  kind: DocumentEventType;
  slug: DocumentSlug;
  docVersion: number;
  title: string;
  // Content address of the new bytes. Populated for `document.created` /
  // `document.updated` (the only kinds that write a blob); absent for
  // the head-only edits (renamed / filename_changed / archived) that
  // never bump `docVersion`. Threaded into the instrumentation stream so
  // downstream consumers can link `(slug, docVersion)` → blob.
  contentHash?: string;
  changedBy: string;
  changedAt: string;
}>;

// `before`/`after` are the structured event bodies; the ChangeLog repo
// owns JSON-encoding them into the ledger columns.
export type CollectionChange = Readonly<{
  kind: CollectionEventType;
  collectionSlug: CollectionSlug;
  documentSlug?: DocumentSlug;
  before?: Readonly<Record<string, unknown>>;
  after?: Readonly<Record<string, unknown>>;
  changedBy: string;
  changedAt: string;
}>;

// The created-vs-updated rule, in one place.
export function documentChange(
  args: Readonly<{
    existed: boolean;
    slug: DocumentSlug;
    docVersion: number;
    title: string;
    contentHash: string;
    changedBy: string;
    changedAt: string;
  }>,
): DocumentChange {
  return {
    kind: args.existed ? "document.updated" : "document.created",
    slug: args.slug,
    docVersion: args.docVersion,
    title: args.title,
    contentHash: args.contentHash,
    changedBy: args.changedBy,
    changedAt: args.changedAt,
  };
}

// A title-only metadata change. The document's content and `docVersion`
// are untouched (title is head-pointer metadata, never part of the
// content-addressed version chain) — `docVersion` is the unchanged head.
export function documentRenamed(
  args: Readonly<{
    slug: DocumentSlug;
    docVersion: number;
    title: string;
    changedBy: string;
    changedAt: string;
  }>,
): DocumentChange {
  return {
    kind: "document.renamed",
    slug: args.slug,
    docVersion: args.docVersion,
    title: args.title,
    changedBy: args.changedBy,
    changedAt: args.changedAt,
  };
}

// A `filename` change. Like `documentRenamed` this is a head-only edit
// (no blob / `DocumentVersion` / `docVersion` bump), but it is a
// DISTINCT op + event: its consequence is a path-map mutation (other
// documents' resolved relative links change), not a display refresh —
// so the DO pairs it with the path-map fan-out. `title` rides along
// (the head's current title) so the event payload stays meaningful.
export function documentFilenameChanged(
  args: Readonly<{
    slug: DocumentSlug;
    docVersion: number;
    title: string;
    changedBy: string;
    changedAt: string;
  }>,
): DocumentChange {
  return {
    kind: "document.filename_changed",
    slug: args.slug,
    docVersion: args.docVersion,
    title: args.title,
    changedBy: args.changedBy,
    changedAt: args.changedAt,
  };
}

// Soft-delete. Head-only (no blob / `DocumentVersion` / `docVersion`
// bump) like the rename events — the consequence is detach-from-all-
// collections + hide, recorded here for the audit log. `docVersion`/`title`
// are the unchanged head at archive time.
export function documentArchived(
  args: Readonly<{
    slug: DocumentSlug;
    docVersion: number;
    title: string;
    changedBy: string;
    changedAt: string;
  }>,
): DocumentChange {
  return {
    kind: "document.archived",
    slug: args.slug,
    docVersion: args.docVersion,
    title: args.title,
    changedBy: args.changedBy,
    changedAt: args.changedAt,
  };
}

// THE complete editable head-node surface for a collection — what
// `collectionUpdated`'s `before`/`after` carry so an audit consumer can
// reconstruct which field changed without re-reading the node, and what
// the EventLogStore's `collection.updated` row parses on decode. One
// Zod schema, one inferred TS type — add a new editable field here once
// and every downstream (the change-event builder, the audit decoder,
// the project-store narrowing) picks it up.
export const CollectionMetadataSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  alwaysIncludeBudgetTokens: alwaysIncludeBudgetTokensZ,
});
export type CollectionMetadata = Readonly<
  z.infer<typeof CollectionMetadataSchema>
>;

// A collection name/description/budget edit. Membership is unchanged,
// so no new CollectionVersion is cut — this is head-node metadata only.
// `before`/`after` carry every editable field every time so a consumer
// diffs `before` vs `after` rather than re-reading the node.
export function collectionUpdated(
  args: Readonly<{
    collectionSlug: CollectionSlug;
    before: CollectionMetadata;
    after: CollectionMetadata;
    changedBy: string;
    changedAt: string;
  }>,
): CollectionChange {
  return {
    kind: "collection.updated",
    collectionSlug: args.collectionSlug,
    before: compact(args.before),
    after: compact(args.after),
    changedBy: args.changedBy,
    changedAt: args.changedAt,
  };
}

export function collectionCreated(
  args: Readonly<{
    collectionSlug: CollectionSlug;
    name: string;
    changedBy: string;
    changedAt: string;
  }>,
): CollectionChange {
  return {
    kind: "collection.created",
    collectionSlug: args.collectionSlug,
    after: { name: args.name },
    changedBy: args.changedBy,
    changedAt: args.changedAt,
  };
}

export function documentDetached(
  args: Readonly<{
    collectionSlug: CollectionSlug;
    documentSlug: DocumentSlug;
    position: number;
    changedBy: string;
    changedAt: string;
  }>,
): CollectionChange {
  return {
    kind: "collection.detached",
    collectionSlug: args.collectionSlug,
    documentSlug: args.documentSlug,
    before: { position: args.position },
    changedBy: args.changedBy,
    changedAt: args.changedAt,
  };
}

// A bulk re-order of a whole collection — one event for the collection,
// not per moved document (the snapshot pins the new order).
export function collectionReordered(
  args: Readonly<{
    collectionSlug: CollectionSlug;
    order: readonly string[];
    changedBy: string;
    changedAt: string;
  }>,
): CollectionChange {
  return {
    kind: "collection.reordered",
    collectionSlug: args.collectionSlug,
    after: { order: args.order },
    changedBy: args.changedBy,
    changedAt: args.changedAt,
  };
}

// Presence of `previousPosition` is the attached-vs-reordered rule, in
// one place.
export function documentAttached(
  args: Readonly<{
    collectionSlug: CollectionSlug;
    documentSlug: DocumentSlug;
    position: number;
    previousPosition: number | undefined;
    changedBy: string;
    changedAt: string;
  }>,
): CollectionChange {
  const reordered = args.previousPosition !== undefined;
  const kind: CollectionEventType = reordered
    ? "collection.reordered"
    : "collection.attached";
  return compact({
    kind,
    collectionSlug: args.collectionSlug,
    documentSlug: args.documentSlug,
    before: reordered ? { position: args.previousPosition } : undefined,
    after: { position: args.position },
    changedBy: args.changedBy,
    changedAt: args.changedAt,
  });
}

// Folder→collection link attached or re-positioned. Membership-affecting
// (the resolved expansion changes), so the DO cuts a fresh
// CollectionVersion exactly like a document attach. `folderSlug` rides in
// before/after for the audit ledger; subscribers re-pull the expanded
// corpus.
export function folderAttached(
  args: Readonly<{
    collectionSlug: CollectionSlug;
    folderSlug: FolderSlug;
    position: number;
    previousPosition: number | undefined;
    changedBy: string;
    changedAt: string;
  }>,
): CollectionChange {
  const reordered = args.previousPosition !== undefined;
  const kind: CollectionEventType = reordered
    ? "collection.reordered"
    : "collection.attached";
  return compact({
    kind,
    collectionSlug: args.collectionSlug,
    before: reordered
      ? { position: args.previousPosition, folderSlug: args.folderSlug }
      : undefined,
    after: { position: args.position, folderSlug: args.folderSlug },
    changedBy: args.changedBy,
    changedAt: args.changedAt,
  });
}

export function folderDetached(
  args: Readonly<{
    collectionSlug: CollectionSlug;
    folderSlug: FolderSlug;
    position: number;
    changedBy: string;
    changedAt: string;
  }>,
): CollectionChange {
  return {
    kind: "collection.detached",
    collectionSlug: args.collectionSlug,
    before: { position: args.position, folderSlug: args.folderSlug },
    changedBy: args.changedBy,
    changedAt: args.changedAt,
  };
}

// A delivery-tier flip (core ↔ reference) on a collection member. Like a
// reorder it changes the resolved corpus a connection receives (a doc
// moves between the always-included core and the pull-on-demand
// reference set) without touching any document, so it reuses
// `collection.reordered` — subscribers re-pull. `documentSlug`/`folderSlug`
// identify the flipped member; `delivery` is the new tier.
export function collectionDeliveryChanged(
  args: Readonly<{
    collectionSlug: CollectionSlug;
    documentSlug?: DocumentSlug;
    folderSlug?: FolderSlug;
    delivery: CollectionDelivery;
    changedBy: string;
    changedAt: string;
  }>,
): CollectionChange {
  return compact({
    kind: "collection.reordered" as const,
    collectionSlug: args.collectionSlug,
    documentSlug: args.documentSlug,
    after: compact({
      reason: "delivery-changed",
      delivery: args.delivery,
      folderSlug: args.folderSlug,
    }),
    changedBy: args.changedBy,
    changedAt: args.changedAt,
  });
}

// A folder rename/move changes the path-space → every folder-linking
// collection's resolved expansion may differ even though no document
// changed. v1 is a coarse fan-out to those collections; this is the
// per-collection audit event.
export function collectionFolderTreeChanged(
  args: Readonly<{
    collectionSlug: CollectionSlug;
    changedBy: string;
    changedAt: string;
  }>,
): CollectionChange {
  return {
    kind: "collection.reordered",
    collectionSlug: args.collectionSlug,
    after: { reason: "folder-tree-changed" },
    changedBy: args.changedBy,
    changedAt: args.changedAt,
  };
}
