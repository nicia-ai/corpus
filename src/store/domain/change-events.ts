import { z } from "zod";

import type {
  CallerChannel,
  CorpusSlug,
  DocumentSlug,
  FileSlug,
} from "../../ids";
import { alwaysIncludeBudgetTokensZ, compact } from "../../util";

// The change-event vocabulary — the single source of event-type
// strings, so callers stay typed instead of hand-building literals. The
// runtime `as const` arrays let the real-time wire enum (presence.ts) derive
// its action list from this one source, so a new kind can't silently fail
// the WebSocket channel's validation.
export const DOCUMENT_EVENT_TYPES = [
  "document.created",
  "document.updated",
  "document.renamed",
  "document.filename_changed",
  "document.archived",
] as const;
export type DocumentEventType = (typeof DOCUMENT_EVENT_TYPES)[number];

// A file is created (uploaded) or deleted. A file has no version chain, so
// there is no "updated" yet; replacing one in place (the CLI and REST
// writes) adds `file.replaced` with before/after hashes when it lands. The
// Git mirror subscribes to this family, never to R2.
export const FILE_EVENT_TYPES = [
  "file.created",
  "file.moved",
  "file.deleted",
] as const;
export type FileEventType = (typeof FILE_EVENT_TYPES)[number];

// `attached` / `detached` now mean a document MOVED into / out of a
// corpus (membership is "under the corpus root"; there is no attaching).
// `reordered` survives only as the coarse "this corpus's tree changed"
// signal. Rows written under the older meanings (attach, detach, drag
// reorder, delivery flips) share these kinds and still decode.
export const COLLECTION_EVENT_TYPES = [
  "collection.created",
  "collection.updated",
  "collection.attached",
  "collection.detached",
  "collection.reordered",
  "collection.deleted",
] as const;
export type CollectionEventType = (typeof COLLECTION_EVENT_TYPES)[number];

// When a save materialized an applied suggestion, the durable origin link:
// the suggestion id, its author (a user id, or a CallerRef for an agent),
// and the transport the proposal arrived through. Recorded on the save's
// change event so an audit can trace a version back to the agent (or human)
// that proposed it — `changedBy` is the human approver, this is the origin.
export type AppliedFrom = Readonly<{
  suggestionId: number;
  by: string;
  channel: CallerChannel;
}>;

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
  // Present only when this version came from applying a suggestion.
  appliedFrom?: AppliedFrom;
  changedBy: string;
  changedAt: string;
}>;

// `before`/`after` are the structured event bodies; the ChangeLog repo
// owns JSON-encoding them into the ledger columns.
export type CollectionChange = Readonly<{
  kind: CollectionEventType;
  collectionSlug: CorpusSlug;
  documentSlug?: DocumentSlug;
  before?: Readonly<Record<string, unknown>>;
  after?: Readonly<Record<string, unknown>>;
  changedBy: string;
  changedAt: string;
}>;

// A file change names the corpus the file is in (its folder ancestry's
// root), because every consumer, the mirror above all, thinks per corpus.
// `filename` and the content fields are present on `file.created`; a
// cascade delete knows only the slug.
export type FileChange = Readonly<{
  kind: FileEventType;
  fileSlug: FileSlug;
  corpusSlug: CorpusSlug;
  // `file.moved`: the corpus it left (the same as `corpusSlug` for a move
  // within one corpus).
  fromCorpusSlug?: CorpusSlug;
  filename?: string;
  contentHash?: string;
  contentType?: string;
  size?: number;
  changedBy: string;
  changedAt: string;
}>;

export function fileCreated(
  args: Readonly<{
    fileSlug: FileSlug;
    corpusSlug: CorpusSlug;
    filename: string;
    contentHash: string;
    contentType: string;
    size: number;
    changedBy: string;
    changedAt: string;
  }>,
): FileChange {
  return { kind: "file.created", ...args };
}

export function fileMoved(
  args: Readonly<{
    fileSlug: FileSlug;
    corpusSlug: CorpusSlug;
    fromCorpusSlug: CorpusSlug;
    filename: string;
    contentHash: string;
    changedBy: string;
    changedAt: string;
  }>,
): FileChange {
  return { kind: "file.moved", ...args };
}

export function fileDeleted(
  args: Readonly<{
    fileSlug: FileSlug;
    corpusSlug: CorpusSlug;
    changedBy: string;
    changedAt: string;
  }>,
): FileChange {
  return { kind: "file.deleted", ...args };
}

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
    appliedFrom?: AppliedFrom;
  }>,
): DocumentChange {
  const change: DocumentChange = {
    kind: args.existed ? "document.updated" : "document.created",
    slug: args.slug,
    docVersion: args.docVersion,
    title: args.title,
    contentHash: args.contentHash,
    changedBy: args.changedBy,
    changedAt: args.changedAt,
  };
  return args.appliedFrom === undefined
    ? change
    : { ...change, appliedFrom: args.appliedFrom };
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
  // Written by edits made before corpora lost their budget; kept so those
  // rows still decode. New edits omit it.
  alwaysIncludeBudgetTokens: alwaysIncludeBudgetTokensZ.optional(),
});
export type CollectionMetadata = Readonly<
  z.infer<typeof CollectionMetadataSchema>
>;

// A collection name/description edit. Membership is unchanged,
// so no new CollectionVersion is cut — this is head-node metadata only.
// `before`/`after` carry every editable field every time so a consumer
// diffs `before` vs `after` rather than re-reading the node.
export function collectionUpdated(
  args: Readonly<{
    corpusSlug: CorpusSlug;
    before: CollectionMetadata;
    after: CollectionMetadata;
    changedBy: string;
    changedAt: string;
  }>,
): CollectionChange {
  return {
    kind: "collection.updated",
    collectionSlug: args.corpusSlug,
    before: compact(args.before),
    after: compact(args.after),
    changedBy: args.changedBy,
    changedAt: args.changedAt,
  };
}

export function collectionCreated(
  args: Readonly<{
    corpusSlug: CorpusSlug;
    name: string;
    changedBy: string;
    changedAt: string;
  }>,
): CollectionChange {
  return {
    kind: "collection.created",
    collectionSlug: args.corpusSlug,
    after: { name: args.name },
    changedBy: args.changedBy,
    changedAt: args.changedAt,
  };
}

// Why a document left or joined a corpus. `moved` is a person moving it
// between corpora; `single-corpus-layout` is the one-time layout pass
// resolving a document that used to sit in several corpora.
export const MEMBERSHIP_REASON_MOVED = "moved";
export const MEMBERSHIP_REASON_LAYOUT = "single-corpus-layout";

// A document moved between corpora: one event on the corpus it left, one
// on the corpus it joined, each naming the other side.
export function documentMovedOut(
  args: Readonly<{
    corpusSlug: CorpusSlug;
    documentSlug: DocumentSlug;
    toCorpusSlug: CorpusSlug;
    reason: typeof MEMBERSHIP_REASON_MOVED | typeof MEMBERSHIP_REASON_LAYOUT;
    changedBy: string;
    changedAt: string;
  }>,
): CollectionChange {
  return {
    kind: "collection.detached",
    collectionSlug: args.corpusSlug,
    documentSlug: args.documentSlug,
    after: { reason: args.reason, movedTo: args.toCorpusSlug },
    changedBy: args.changedBy,
    changedAt: args.changedAt,
  };
}

export function documentMovedIn(
  args: Readonly<{
    corpusSlug: CorpusSlug;
    documentSlug: DocumentSlug;
    fromCorpusSlug: CorpusSlug;
    changedBy: string;
    changedAt: string;
  }>,
): CollectionChange {
  return {
    kind: "collection.attached",
    collectionSlug: args.corpusSlug,
    documentSlug: args.documentSlug,
    after: { reason: MEMBERSHIP_REASON_MOVED, movedFrom: args.fromCorpusSlug },
    changedBy: args.changedBy,
    changedAt: args.changedAt,
  };
}

export function collectionDeleted(
  args: Readonly<{
    corpusSlug: CorpusSlug;
    name: string;
    pages: "archive" | "move-to-default";
    changedBy: string;
    changedAt: string;
  }>,
): CollectionChange {
  return {
    kind: "collection.deleted",
    collectionSlug: args.corpusSlug,
    before: { name: args.name },
    after: { pages: args.pages },
    changedBy: args.changedBy,
    changedAt: args.changedAt,
  };
}

// Something inside a corpus's tree changed its paths or its document set
// (a folder renamed or moved, a document placed, renamed or archived)
// without any single document's bytes changing. The per-corpus audit
// event subscribers re-pull the outline on.
export function collectionFolderTreeChanged(
  args: Readonly<{
    corpusSlug: CorpusSlug;
    changedBy: string;
    changedAt: string;
  }>,
): CollectionChange {
  return {
    kind: "collection.reordered",
    collectionSlug: args.corpusSlug,
    after: { reason: "folder-tree-changed" },
    changedBy: args.changedBy,
    changedAt: args.changedAt,
  };
}
