import {
  defineEdge,
  defineGraph,
  defineNode,
  searchable,
} from "@nicia-ai/typegraph";
import { z } from "zod";

import {
  COLLECTION_DELIVERY_VALUES,
  DEFAULT_COLLECTION_DELIVERY,
} from "./store/domain/collection-expand";
import {
  alwaysIncludeBudgetTokensZ,
  DEFAULT_ALWAYS_INCLUDE_BUDGET_TOKENS,
} from "./util";

export const GRAPH_ID = "corpus";

export const DOCUMENT_BY_SLUG = "DocumentBySlug";
export const COLLECTION_BY_SLUG = "CollectionBySlug";
export const FOLDER_BY_SLUG = "FolderBySlug";
export const DOCUMENT_VERSION_BY_SLUG_VERSION = "DocumentVersionBySlugVersion";
export const COLLECTION_VERSION_BY_SLUG_VERSION =
  "CollectionVersionBySlugVersion";

// A canonical document. The node holds only the mutable head pointer;
// content is content-addressed in `content_blobs` (src/db.ts) and
// referenced by `contentHash`. Full immutable history is the
// `DocumentVersion` chain. `kind` is reserved by TypeGraph — the version
// column is `docVersion`, never `version`/`kind`.
//
// Three names, deliberately distinct: `slug` = stable internal identity
// (set once, never reverse-parsed for a path); `filename` = original
// basename incl. extension (the path segment for link resolution),
// head-only mutable metadata; `title` = display, inferred from `#
// heading` / editable. `path` is DERIVED (folder ancestry + `filename`)
// and never stored.
export const Document = defineNode("Document", {
  schema: z.object({
    slug: z.string().min(1),
    title: z.string().min(1),
    filename: z.string().min(1),
    contentHash: z.string().min(1),
    docVersion: z.number().int().nonnegative(),
    updatedAt: z.string(),
    // Soft-delete marker (head-pointer metadata, like `title`/`filename`
    // — no version cut). Set = archived: detached from collections, hidden
    // from the documents list + MCP, but the version chain and blobs are
    // kept so immutable CollectionVersion snapshots and bundle round-trip
    // stay valid. Absent (the common case) = active.
    archivedAt: z.string().optional(),
    // DERIVED full-text index content (title + current body), tokenized by
    // FTS5 for `store.search.fulltext`. Recomputed on every head change
    // (save / rename / bundle import) and cleared on archive so soft-deleted
    // docs leave the index. Canonical content is the blob ledger, never this
    // — it is deliberately excluded from the bundle (`exportBundle` enumerates
    // meta fields explicitly) and recomputed on import.
    searchText: searchable().optional(),
  }),
});

// An immutable, content-addressed version of a document with a
// `prevContentHash` link to its predecessor (null at genesis). This is
// the ONLY version store — there is no relational version ledger. The
// unique `(slug, docVersion)` constraint is the optimistic-concurrency
// enforcer: two racing saves both computing N+1 collide here and the
// whole enlisted tx rolls back.
export const DocumentVersion = defineNode("DocumentVersion", {
  schema: z.object({
    slug: z.string().min(1),
    docVersion: z.number().int().positive(),
    contentHash: z.string().min(1),
    prevContentHash: z.string().nullable(),
    changedAt: z.string(),
    changedBy: z.string(),
    diffSummary: z.string().optional(),
  }),
});

// A collection: the ordered set of documents one agent reads. Members
// are categorised at the edge level by `delivery` (`core` = pre-loaded
// by `read_collection`; `reference` = stays in the outline, pulled on
// demand). `alwaysIncludeBudgetTokens` is the per-collection size
// threshold the authoring UI compares the assembled core set against —
// informational; MCP never enforces it.
export const Collection = defineNode("Collection", {
  schema: z.object({
    slug: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    alwaysIncludeBudgetTokens: alwaysIncludeBudgetTokensZ.default(
      DEFAULT_ALWAYS_INCLUDE_BUDGET_TOKENS,
    ),
  }),
});

// An immutable membership snapshot, created on every membership-affecting
// change (collection created, attach, reorder). `members` is the ordered
// resolved set, each member pinned to the document's current
// `DocumentVersion` — a serialized, reproducible-to-bytes CorpusVersion.
export const CollectionVersion = defineNode("CollectionVersion", {
  schema: z.object({
    collectionSlug: z.string().min(1),
    collectionVersion: z.number().int().positive(),
    members: z.string(),
    changedAt: z.string(),
    changedBy: z.string(),
  }),
});

// The single-parent organizational home (authoring plane). The node
// holds no parent — parent is the inbound `folder_child` edge (one
// canonical source, no scalar/edge drift). `name` is the path SEGMENT
// (original directory basename at import, user-editable later); it is
// not a slug. Folders are pure containment; cross-cutting membership is
// the `Collection`/`includes` layer's job.
export const Folder = defineNode("Folder", {
  schema: z.object({
    slug: z.string().min(1),
    name: z.string().min(1),
    createdAt: z.string(),
  }),
});

const collectionMembershipSchema = z.object({
  position: z.number().int().nonnegative(),
  // `core` is included by `read_collection`; `reference` stays reachable
  // through the outline/list/read_document path. Default `core` so a
  // programmatic attach (no tier specified) shows up in the corpus.
  delivery: z
    .enum(COLLECTION_DELIVERY_VALUES)
    .default(DEFAULT_COLLECTION_DELIVERY),
});

// Direction Collection -> Document so read_collection is a one-hop `out`
// traversal; `position` orders the assembled corpus (read app-side).
export const includes = defineEdge("includes", {
  schema: collectionMembershipSchema,
  from: [Collection],
  to: [Document],
});

// Document -> its versions (history traversal, bundle export).
export const versionsOf = defineEdge("versions_of", {
  schema: z.object({}),
  from: [Document],
  to: [DocumentVersion],
});

// Collection -> its membership snapshots.
export const versionOfCollection = defineEdge("version_of_collection", {
  schema: z.object({}),
  from: [Collection],
  to: [CollectionVersion],
});

// Parent -> child folder. Direction parent->child so listing a
// folder's children (tree render) is a one-hop `findFrom`; the upward
// ancestry walk (path derivation) is `findTo` on the child. Single
// parent is repo-enforced (at most one inbound edge per child).
// `position` orders siblings.
export const folderChild = defineEdge("folder_child", {
  schema: z.object({ position: z.number().int().nonnegative() }),
  from: [Folder],
  to: [Folder],
});

// Document -> its single home Folder. Direction doc->folder so "which
// folder am I in" (the hot path-derivation lookup) is a one-hop
// `findFrom` on the document; "documents in this folder" is `findTo`.
// At most one such edge per document (repo-enforced single-parent).
export const inFolder = defineEdge("in_folder", {
  schema: z.object({ position: z.number().int().nonnegative() }),
  from: [Document],
  to: [Folder],
});

// Collection -> a Folder it includes transitively (the folder→collection
// link). `position` shares ONE space with `includes` so an author can
// interleave direct documents and folder includes in a single order;
// the shared resolver (store/domain/collection-expand.ts) merges both edge
// lists by position and expands folders depth-first. The published
// CollectionVersion stays a verbatim pinned-document snapshot — the link
// is live only at authoring/read time.
export const includesFolder = defineEdge("includes_folder", {
  schema: collectionMembershipSchema,
  from: [Collection],
  to: [Folder],
});

// Inferred user-defined fields for each node, suitable for downstream
// DTO derivation (Pick / Omit) so a node's editable surface lives in
// exactly one place — the Zod schema above. These DO NOT include
// TypeGraph-internal columns (id, etc.); they are the shape the
// codebase passes to `Node.create`/`Node.update` and returns from the
// repo layer.
export type DocumentFields = Readonly<z.infer<typeof Document.schema>>;
export type DocumentVersionFields = Readonly<
  z.infer<typeof DocumentVersion.schema>
>;
export type CollectionFields = Readonly<z.infer<typeof Collection.schema>>;
export type CollectionVersionFields = Readonly<
  z.infer<typeof CollectionVersion.schema>
>;
export type FolderFields = Readonly<z.infer<typeof Folder.schema>>;

export const canonicalGraph = defineGraph({
  id: GRAPH_ID,
  nodes: {
    Document: {
      type: Document,
      unique: [
        {
          name: DOCUMENT_BY_SLUG,
          fields: ["slug"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
    DocumentVersion: {
      type: DocumentVersion,
      unique: [
        {
          name: DOCUMENT_VERSION_BY_SLUG_VERSION,
          fields: ["slug", "docVersion"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
    Collection: {
      type: Collection,
      unique: [
        {
          name: COLLECTION_BY_SLUG,
          fields: ["slug"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
    CollectionVersion: {
      type: CollectionVersion,
      unique: [
        {
          name: COLLECTION_VERSION_BY_SLUG_VERSION,
          fields: ["collectionSlug", "collectionVersion"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
    Folder: {
      type: Folder,
      unique: [
        {
          name: FOLDER_BY_SLUG,
          fields: ["slug"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {
    includes: { type: includes, from: [Collection], to: [Document] },
    includes_folder: {
      type: includesFolder,
      from: [Collection],
      to: [Folder],
    },
    folder_child: { type: folderChild, from: [Folder], to: [Folder] },
    in_folder: { type: inFolder, from: [Document], to: [Folder] },
    versions_of: {
      type: versionsOf,
      from: [Document],
      to: [DocumentVersion],
    },
    version_of_collection: {
      type: versionOfCollection,
      from: [Collection],
      to: [CollectionVersion],
    },
  },
});

export type CanonicalGraph = typeof canonicalGraph;
