import type { CollectionSlug, DocumentSlug, FolderSlug } from "../ids";
import type { CollectionDelivery } from "../store/domain/collection-expand";
import type { LinkKind } from "../store/domain/links";

export type SaveDocumentInput = Readonly<{
  slug: DocumentSlug;
  markdown: string;
  title?: string;
  /** Original basename incl. extension. Defaults to `<slug>.md` for
   * editor-created docs; bulk uploads pass the real basename. */
  filename?: string;
  /** Create the document directly in this folder (null / absent = project
   * root), atomically with the save — the "New document in this folder"
   * path. Also scopes the brand-new-filename collision check to that
   * folder's sibling namespace. Create-only (`clientVersion === 0`): on an
   * update it is inert, since moving a document is `placeDocumentInFolder`'s
   * job. Editor / REST saves omit it (root). */
  folderSlug?: FolderSlug | null;
  /** Version the client loaded. Must equal the server head, else 409. */
  clientVersion: number;
  changedBy: string;
  /** Test-only: throw after all writes to prove the tx rolls back. */
  __failAfterWrites?: boolean;
}>;

export type RenameDocumentInput = Readonly<{
  slug: DocumentSlug;
  title: string;
  changedBy: string;
}>;

export type RenameFilenameInput = Readonly<{
  slug: DocumentSlug;
  filename: string;
  changedBy: string;
}>;

export type RenameFilenameResult = Readonly<
  { ok: true } | { ok: false; reason: "missing" | "segment-collision" }
>;

export type UpdateCollectionInput = Readonly<{
  slug: CollectionSlug;
  name: string;
  description?: string;
  // Absent = preserve the current value (a patch, unlike `description`
  // where absent clears). The web form always sends an explicit number.
  alwaysIncludeBudgetTokens?: number;
  changedBy: string;
}>;

export type SaveResult = Readonly<
  | { ok: true; docVersion: number }
  | { ok: false; conflict: true; currentVersion: number }
  | { ok: false; segmentCollision: true }
  // Markdown over MAX_MARKDOWN_BYTES (src/util.ts) — refused before any
  // write; transports map it to validation (HTTP 400/413).
  | { ok: false; tooLarge: true }
  | { ok: false; rolledBack: true }
>;

// A scoped create either lands a new document or refuses because the slug
// already exists outside the bound Collection — another scope's document,
// which the credential may never write. The existence check is decided
// inside the create transaction, so the refusal is atomic with the write.
export type CreateInCollectionResult =
  SaveResult | Readonly<{ ok: false; forbidden: true }>;

export type DocumentSnapshot = Readonly<{
  slug: string;
  title: string;
  filename: string;
  markdown: string;
  docVersion: number;
  updatedAt: string;
}>;

export type DocumentHistoryEntry = Readonly<{
  docVersion: number;
  changedAt: string;
  changedBy: string;
  diffSummary?: string;
  markdown: string;
  retained: boolean;
}>;

export type DocumentHistoryMeta = Readonly<{
  docVersion: number;
  changedAt: string;
  changedBy: string;
  diffSummary?: string;
  retained: boolean;
}>;

export type ReapResult = Readonly<{
  versionsDeleted: number;
  eventsDeleted: number;
  blobsDeleted: number;
}>;

// Only what the DO method itself can return. Parse-time variants
// (`version-mismatch`, `invalid-bundle-shape`) come from `parseBundle`
// in the server fn and are never produced here; widening this union
// would create dead branches downstream.
export type ImportResult = Readonly<
  | { ok: true; documents: number; collections: number }
  | { ok: false; reason: "root-hash-mismatch" }
>;

export type SeedResult = Readonly<
  { seeded: true } | { seeded: false; reason: "not_empty" }
>;

// Bulk folder upload, per-document outcome: a fresh path is `created`,
// a re-uploaded path is a new version of the SAME document
// (`created: false`) — idempotent on path, never a duplicate.
// `folderSlug` is the document's immediate parent (null = project root);
// `createdFolders` are the folder slugs this import minted to place it
// (empty when every ancestor already existed). Together they let the DO
// derive the collection-link target from ground truth.
export type ImportDocResult = Readonly<
  | {
      ok: true;
      slug: string;
      docVersion: number;
      created: boolean;
      folderSlug: string | null;
      createdFolders: readonly string[];
    }
  | { ok: false; reason: "invalid-path" | "segment-collision" | "too-large" }
>;

export type ImportSummary = Readonly<{
  created: number;
  updated: number;
  failed: readonly Readonly<{ path: string; reason: string }>[];
}>;

export type ImportCollectionLink = Readonly<
  | { mode: "none" }
  | { mode: "existing"; slug: CollectionSlug }
  | { mode: "new"; name: string }
>;

export type ImportAndLinkInput = Readonly<{
  entries: readonly Readonly<{ path: string; markdown: string }>[];
  link: ImportCollectionLink;
  changedBy: string;
}>;

export type ImportAndLinkResult = Readonly<{
  summary: ImportSummary;
  linkedTo: CollectionSlug | undefined;
}>;

export type ProjectUsageSnapshot = Readonly<{
  activeDocuments: number;
  collections: number;
  documentVersions: number;
  storedMarkdownBytes: number;
}>;

// One full-text search hit over live document heads, ranked by FTS5
// relevance (bm25). `snippet` is a highlighted excerpt from the match,
// carrying `<mark>…</mark>` delimiters around the matched terms; empty when
// the backend produced no fragment.
export type DocumentSearchHit = Readonly<{
  slug: string;
  title: string;
  path: string;
  snippet: string;
}>;

// The agent-facing folder projection — one resolved link. `kind` is
// how the link was written (`path` = CommonMark relative destination,
// `wiki` = Obsidian-style `[[target]]`). `documentSlug` is null when it
// dangles (escapes the project, or nothing matches the target);
// `inCollection` is true when that target is itself in this
// collection's resolved expansion.
export type OutlineLink = Readonly<{
  target: string;
  kind: LinkKind;
  resolvedPath: string | null;
  documentSlug: string | null;
  inCollection: boolean;
}>;

export type OutlineDoc = Readonly<{
  slug: string;
  path: string;
  title: string;
  docVersion: number;
  delivery: CollectionDelivery;
  links: readonly OutlineLink[];
}>;

// Tree-ordered with derived paths + resolved links — the whole
// hierarchy + link graph in one cheap read. Bytes are never rewritten;
// this is `parsed-links ⊕ current path map`, computed at projection time.
export type CollectionOutline = Readonly<
  | { found: false }
  | {
      found: true;
      collection: string;
      name: string;
      documents: readonly OutlineDoc[];
    }
>;
