import type { CorpusSlug, DocumentSlug } from "../ids";
import type { CorpusLocation } from "../store/domain/corpus-drive";
import type { LinkKind } from "../store/domain/links";
import type { SectionMatch, SectionTarget } from "../store/domain/sections";

export type SaveDocumentInput = Readonly<{
  slug: DocumentSlug;
  markdown: string;
  title?: string;
  /** Original basename incl. extension. Defaults to `<slug>.md` for
   * editor-created docs; bulk uploads pass the real basename. */
  filename?: string;
  /** Where a NEW document is created: a corpus and, optionally, a folder
   * of it (absent = the default corpus's root — the drafts space). The
   * placement rides the same transaction as the save, so a document never
   * exists outside a corpus. Create-only (`clientVersion === 0`): on an
   * update it is inert, since moving a document is `moveDocuments`' job. */
  location?: CorpusLocation;
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

export type UpdateCorpusInput = Readonly<{
  slug: CorpusSlug;
  name: string;
  description?: string;
  changedBy: string;
}>;

// What happens to a deleted corpus's pages: archived with it (the same
// soft delete a single page gets — recoverable), or moved to the default
// corpus so they survive as drafts.
export const CORPUS_DELETE_PAGE_MODES = ["archive", "move-to-default"] as const;
export type CorpusDeletePageMode = (typeof CORPUS_DELETE_PAGE_MODES)[number];

export type DeleteCorpusInput = Readonly<{
  slug: CorpusSlug;
  pages: CorpusDeletePageMode;
  changedBy: string;
}>;

export type DeleteCorpusResult = Readonly<
  | { ok: true; archivedSlugs: readonly DocumentSlug[]; moved: number }
  | { ok: false; reason: "missing" | "default-corpus" }
>;

export type MoveDocumentsResult = Readonly<{ moved: number; failed: number }>;

export type SaveResult = Readonly<
  | { ok: true; docVersion: number }
  | { ok: false; conflict: true; currentVersion: number }
  | { ok: false; segmentCollision: true }
  // Markdown over MAX_MARKDOWN_BYTES (src/util.ts) — refused before any
  // write; transports map it to validation (HTTP 400/413).
  | { ok: false; tooLarge: true }
  // A new document named a corpus or folder that does not exist (or a
  // folder of a different corpus); nothing was written.
  | { ok: false; unknownLocation: true }
  | { ok: false; rolledBack: true }
>;

export type SaveSharedDraftResult =
  SaveResult | Readonly<{ ok: false; served: true }>;

export type SaveSharedSectionInput = Readonly<{
  slug: DocumentSlug;
  target: SectionTarget;
  /** The section's new content, without its heading line. */
  body: string;
  /** Version the client last read. A newer head is accepted when the target
   * section is byte-identical in both; otherwise 409. */
  clientVersion: number;
  changedBy: string;
}>;

export type SaveSharedSectionResult =
  | Readonly<{ ok: true; docVersion: number; created: boolean }>
  | Exclude<SaveSharedDraftResult, Readonly<{ ok: true }>>
  | Readonly<{ ok: false; missing: true }>
  | Readonly<{
      ok: false;
      ambiguous: true;
      matches: readonly SectionMatch[];
    }>
  | Readonly<{ ok: false; invalidBody: true; error: string }>;

// A scoped create either lands a new document or refuses because the slug
// already exists outside the bound Corpus — another scope's document,
// which the credential may never write — or because the bound Corpus is
// gone. The check is decided inside the create transaction, so the refusal
// is atomic with the write.
export type CreateInCorpusResult =
  SaveResult | Readonly<{ ok: false; forbidden: true }>;

// A new document created at a corpus-relative path with a server-derived
// slug (the REST create): the slug it got, or why nothing was written.
export type CreateAtPathResult = Readonly<
  | { ok: true; slug: string; docVersion: number }
  | Exclude<CreateInCorpusResult, { ok: true }>
>;

// Removing a document from a corpus by archiving it.
export type ArchiveInCorpusResult = Readonly<
  | { ok: true }
  | { ok: false; notFound: true }
  | { ok: false; conflict: true; currentVersion: number }
>;

// Moving a document to another path of its own corpus.
export type MoveToPathResult = Readonly<
  | { ok: true; changed: boolean }
  | { ok: false; notFound: true }
  | { ok: false; segmentCollision: true }
>;

// A live document's place: the corpus it is in and its path inside that
// corpus. `folderSlug` is null when it sits directly in the corpus root.
export type DocumentLocation = Readonly<{
  slug: string;
  corpusSlug: CorpusSlug;
  path: string;
  folderSlug: string | null;
}>;

export type DocumentRef = Readonly<{
  slug: string;
  path: string;
  corpusSlug: string;
}>;

export type DocumentListRow = Readonly<{
  slug: string;
  title: string;
  docVersion: number;
  size: number;
  filename: string;
  corpusSlug: CorpusSlug;
  path: string;
  folderSlug: string | null;
  updatedAt: string;
}>;

// A folder as a person sees it: inside one corpus, never the corpus root
// itself. `parentSlug` is null directly under the root.
export type CorpusFolderView = Readonly<{
  slug: string;
  name: string;
  corpusSlug: CorpusSlug;
  parentSlug: string | null;
}>;

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
  | { ok: true; documents: number; corpora: number }
  | { ok: false; reason: "root-hash-mismatch" }
>;

export type SeedResult = Readonly<
  { seeded: true } | { seeded: false; reason: "not_empty" }
>;

export type EnsureDefaultCorpusResult = Readonly<{
  slug: string;
  created: boolean;
}>;

// Bulk folder upload, per-document outcome: a fresh path is `created`,
// a re-uploaded path is a new version of the SAME document
// (`created: false`) — idempotent on path, never a duplicate.
export type ImportDocResult = Readonly<
  | { ok: true; slug: string; docVersion: number; created: boolean }
  | {
      ok: false;
      reason:
        "invalid-path" | "segment-collision" | "too-large" | "missing-corpus";
    }
>;

export type ImportSummary = Readonly<{
  created: number;
  updated: number;
  failed: readonly Readonly<{ path: string; reason: string }>[];
}>;

// The corpus an upload lands in: the drafts space, an existing corpus, or
// a new one named here. Uploaded paths are relative to that corpus's root.
export type ImportDestination = Readonly<
  | { mode: "default" }
  | { mode: "existing"; slug: CorpusSlug }
  | { mode: "new"; name: string }
>;

export type ImportIntoCorpusInput = Readonly<{
  entries: readonly Readonly<{ path: string; markdown: string }>[];
  destination: ImportDestination;
  changedBy: string;
}>;

export type ImportIntoCorpusResult = Readonly<{
  summary: ImportSummary;
  corpusSlug: CorpusSlug;
}>;

export type ProjectUsageSnapshot = Readonly<{
  activeDocuments: number;
  corpora: number;
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
  corpusSlug: string;
  path: string;
  snippet: string;
}>;

// The agent-facing folder projection — one resolved link. `kind` is
// how the link was written (`path` = CommonMark relative destination,
// `wiki` = Obsidian-style `[[target]]`). `documentSlug` is null when it
// dangles (escapes the corpus root, or nothing matches the target);
// `inCorpus` is false when the target was found in a different corpus.
export type OutlineLink = Readonly<{
  target: string;
  kind: LinkKind;
  resolvedPath: string | null;
  documentSlug: string | null;
  inCorpus: boolean;
}>;

export type OutlineDoc = Readonly<{
  slug: string;
  path: string;
  title: string;
  docVersion: number;
  links: readonly OutlineLink[];
}>;

// Path-ordered with corpus-relative paths + resolved links — the whole
// hierarchy + link graph in one cheap read. Bytes are never rewritten;
// this is `parsed-links ⊕ current path map`, computed at projection time.
export type CorpusOutline = Readonly<
  | { found: false }
  | {
      found: true;
      corpus: string;
      name: string;
      documents: readonly OutlineDoc[];
    }
>;
