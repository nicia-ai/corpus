import {
  defineEdge,
  defineGraph,
  defineNode,
  defineNodeIndex,
  searchable,
} from "@nicia-ai/typegraph";
import { z } from "zod";

import {
  COLLECTION_DELIVERY_VALUES,
  DEFAULT_COLLECTION_DELIVERY,
} from "./store/domain/collection-delivery";
import {
  alwaysIncludeBudgetTokensZ,
  DEFAULT_ALWAYS_INCLUDE_BUDGET_TOKENS,
} from "./util";

export const GRAPH_ID = "corpus";

export const DOCUMENT_BY_SLUG = "DocumentBySlug";
export const COLLECTION_BY_SLUG = "CollectionBySlug";
export const FOLDER_BY_SLUG = "FolderBySlug";
export const FILE_BY_SLUG = "FileBySlug";
export const DOCUMENT_VERSION_BY_SLUG_VERSION = "DocumentVersionBySlugVersion";
export const COLLECTION_VERSION_BY_SLUG_VERSION =
  "CollectionVersionBySlugVersion";
export const DOCUMENT_SLUG_INDEX = "corpus_document_slug_idx";
export const FOLDER_SLUG_INDEX = "corpus_folder_slug_idx";
export const FILE_SLUG_INDEX = "corpus_file_slug_idx";
export const FILE_HASH_INDEX = "corpus_file_hash_idx";

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

// A collection — a corpus, the "drive" an agent reads: the documents under
// its one root folder (the single `includes_folder` link). `alwaysIncludeBudgetTokens`
// is a retired field kept so stored nodes and the bundle contract stay
// decodable; nothing reads it.
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

// An uploaded image or attachment. The bytes are NOT here: they live in R2,
// content-addressed under the project (`p/<projectId>/<contentHash>`), so
// this node is only metadata and the head of a file's one and only version
// (replacing a file moves `contentHash`; there is no version chain). It is a
// node, not a side table, because it shares its parent's path namespace with
// documents and folders. `filename` is the path segment; the path is derived
// from the folder ancestry exactly as for a document. Soft-deleted
// (`deletedAt`) until the retention reaper removes it; the R2 object outlives
// it until the orphan sweep finds no node referencing the hash.
export const StoredFile = defineNode("File", {
  schema: z.object({
    slug: z.string().min(1),
    filename: z.string().min(1),
    contentHash: z.string().min(1),
    contentType: z.string().min(1),
    size: z.number().int().nonnegative(),
    createdAt: z.string(),
    deletedAt: z.string().optional(),
  }),
});

const collectionMembershipSchema = z.object({
  position: z.number().int().nonnegative(),
  // Retired tier (`core` / `reference`), kept so edges written before
  // corpora became drives still decode. New edges write the default.
  delivery: z
    .enum(COLLECTION_DELIVERY_VALUES)
    .default(DEFAULT_COLLECTION_DELIVERY),
});

// The pre-drive direct Collection -> Document link. Nothing creates one
// any more (membership is "under the corpus root"); a project written
// before drives still carries them until its layout migration removes them.
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

// File -> its single home Folder, mirroring `in_folder`. At most one per
// file (repo-enforced); "files in this folder" is `findTo`.
export const fileInFolder = defineEdge("file_in_folder", {
  schema: z.object({}),
  from: [StoredFile],
  to: [Folder],
});

// Collection -> its root Folder: the ONE link a corpus has, and the only
// way a document is "in" a corpus (it lives under that folder). `position`
// and `delivery` are retired fields kept decodable; new links write
// position 0 and the default tier.
export const includesFolder = defineEdge("includes_folder", {
  schema: collectionMembershipSchema,
  from: [Collection],
  to: [Folder],
});

// Corpus resolves these identities on nearly every command. TypeGraph's
// unique constraints enforce the invariants through its uniqueness ledger;
// these separate, non-unique relational indexes accelerate the ordinary
// `find({ where })` reads over node props. The version indexes keep the
// sequence field after the slug so a slug-only history scan uses the same
// key prefix.
const documentSlugIndex = defineNodeIndex(Document, {
  name: DOCUMENT_SLUG_INDEX,
  fields: ["slug"],
});
const documentVersionIndex = defineNodeIndex(DocumentVersion, {
  name: "corpus_document_version_idx",
  fields: ["slug", "docVersion"],
});
const collectionSlugIndex = defineNodeIndex(Collection, {
  name: "corpus_collection_slug_idx",
  fields: ["slug"],
});
const collectionVersionIndex = defineNodeIndex(CollectionVersion, {
  name: "corpus_collection_version_idx",
  fields: ["collectionSlug", "collectionVersion"],
});
const folderSlugIndex = defineNodeIndex(Folder, {
  name: FOLDER_SLUG_INDEX,
  fields: ["slug"],
});

const fileSlugIndex = defineNodeIndex(StoredFile, {
  name: FILE_SLUG_INDEX,
  fields: ["slug"],
});
const fileHashIndex = defineNodeIndex(StoredFile, {
  name: FILE_HASH_INDEX,
  fields: ["contentHash"],
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
export type StoredFileFields = Readonly<z.infer<typeof StoredFile.schema>>;

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
    File: {
      type: StoredFile,
      unique: [
        {
          name: FILE_BY_SLUG,
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
    file_in_folder: { type: fileInFolder, from: [StoredFile], to: [Folder] },
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
  indexes: [
    documentSlugIndex,
    documentVersionIndex,
    collectionSlugIndex,
    collectionVersionIndex,
    folderSlugIndex,
    fileSlugIndex,
    fileHashIndex,
  ],
});

export type CanonicalGraph = typeof canonicalGraph;
