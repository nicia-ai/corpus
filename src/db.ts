import { sql } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

import { CALLER_CHANNELS } from "./ids";
import type { BlockKind } from "./store/domain/block-match";
import { HUNK_OPS } from "./store/domain/suggestion";

// Content-addressed blob store, co-located in the DO's SQLite (NOT R2):
// keeping it here preserves the single atomic tx (blob + DocumentVersion
// node + Document node + change event in one ctx.storage.transaction).
// R2 is the documented scale path, not a v1 fallback — it would split the
// atomic boundary. `hash` is `sha256:<hex>` over the *uncompressed*
// markdown; `bytes` is the gzip-compressed payload (BlobStore is the only
// codec seam — see src/store/repos/blob-store.ts). Writes are
// insert-or-ignore (dedup). Document history lives in the
// `DocumentVersion` TypeGraph node (src/graph.ts), not here — this table
// is only the deduplicated bytes.
export const contentBlobs = sqliteTable("content_blobs", {
  hash: text("hash").primaryKey(),
  bytes: blob("bytes", { mode: "buffer" }).notNull(),
  createdAt: text("created_at").notNull(),
});

// Append-only collection-affecting events (created/updated/deleted, attach,
// detach, reorder). Explains "why did the agent stop seeing this doc".
// Operational ledger — deliberately NOT content lineage (that is the
// DocumentVersion / CollectionVersion chain) and never folded into the
// version model. Pure event record; no delivery state machine here.
export const changeEvents = sqliteTable("change_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventType: text("event_type").notNull(),
  documentSlug: text("document_slug"),
  collectionSlug: text("collection_slug"),
  beforeJson: text("before_json"),
  afterJson: text("after_json"),
  changedAt: text("changed_at").notNull(),
  changedBy: text("changed_by").notNull(),
});

// Transactional outbox for the durable instrumentation stream. Mutations append
// `change_events` and enqueue the corresponding EventLogStore envelope in the
// same ProjectStore transaction. Post-commit drain deletes rows only after the
// sibling EventLogStore accepts them, and retries preserve FIFO order.
export const instrumentationOutbox = sqliteTable("instrumentation_outbox", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  localEventId: integer("local_event_id").notNull(),
  schemaVersion: integer("schema_version").notNull(),
  projectId: text("project_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  eventType: text("event_type").notNull(),
  payload: text("payload").notNull(),
  createdAt: text("created_at").notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
});

// --- Collaboration: derived block ids + anchored comments -------------
// Non-canonical side state: off-bundle, off-MCP, reaped with the document
// versions they describe. Enum columns use drizzle `{ enum }` + a CHECK so
// the only storable values are the valid ones; the block map is a typed
// JSON column. Every downstream type is INFERRED from these definitions
// ($inferSelect / $inferInsert) — there is no hand-written row shape to
// drift, so persisting an invalid value is a compile error and a DB error.

// One entry in a version's block map: a stable block id plus its kind. The
// block TEXT is NOT stored — it is recovered by re-parsing the version's
// blob, so the map stays lean (a comment on a long doc costs a handful of
// ids, not a second copy of the prose). `kind` is the domain BlockKind (its
// tuple is the single source for the union); `id` is a BlockId serialized
// as a string, re-branded by the repo on read.
export type BlockMapEntry = Readonly<{
  id: string;
  kind: BlockKind;
}>;

// The ordered block decomposition of one document version: stable block ids
// (minted once, carried forward by the matcher so anchors survive edits and
// moves) tagged with the parser version that produced them. On a parser
// upgrade the tag mismatches and the rebase re-anchors by text quote rather
// than trusting a positional re-parse. One row per (document, version).
export const documentBlockMap = sqliteTable(
  "document_block_map",
  {
    documentSlug: text("document_slug").notNull(),
    docVersion: integer("doc_version").notNull(),
    parserVersion: integer("parser_version").notNull(),
    blocks: text("blocks", { mode: "json" })
      .$type<readonly BlockMapEntry[]>()
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.documentSlug, t.docVersion] })],
);

// Per-document monotonic block-id allocator. Ordinals are never reused, so
// a stale anchor's block id can never collide with a future unrelated
// block.
export const documentBlockSeq = sqliteTable("document_block_seq", {
  documentSlug: text("document_slug").primaryKey(),
  next: integer("next").notNull().default(0),
});

// The lifecycle of a comment thread's anchor — server-controlled: a thread
// opens, is resolved by a person, or orphans when its anchored text is
// gone. The single source for the union and the CHECK below.
export const THREAD_STATUSES = ["open", "resolved", "orphaned"] as const;

// An anchored comment thread — the human review layer. Off-bundle, off-MCP.
export const commentThread = sqliteTable(
  "comment_thread",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    documentSlug: text("document_slug").notNull(),
    anchorBlockId: text("anchor_block_id").notNull(),
    anchorStart: integer("anchor_start").notNull(),
    anchorEnd: integer("anchor_end").notNull(),
    quotePrefix: text("quote_prefix").notNull(),
    quoteExact: text("quote_exact").notNull(),
    quoteSuffix: text("quote_suffix").notNull(),
    status: text("status", { enum: THREAD_STATUSES }).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    resolvedBy: text("resolved_by"),
    resolvedAt: text("resolved_at"),
  },
  (t) => [
    index("comment_thread_doc").on(t.documentSlug),
    check(
      "comment_thread_status_valid",
      sql.raw(`status in (${THREAD_STATUSES.map((s) => `'${s}'`).join(", ")})`),
    ),
  ],
);

// A message within a thread (the opening comment and any replies).
export const comment = sqliteTable(
  "comment",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    threadId: integer("thread_id").notNull(),
    body: text("body").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("comment_thread_id").on(t.threadId)],
);

// Downstream types are INFERRED from the schema above — never hand-written —
// so each column's type (including the status union) is the single source
// of truth shared by repos, DO methods, and DTOs.
export type StoredBlockMap = Readonly<typeof documentBlockMap.$inferSelect>;
export type CommentThreadRow = Readonly<typeof commentThread.$inferSelect>;
export type NewCommentThread = Readonly<typeof commentThread.$inferInsert>;
export type CommentRow = Readonly<typeof comment.$inferSelect>;
export type NewComment = Readonly<typeof comment.$inferInsert>;
export type CommentStatus = CommentThreadRow["status"];

// --- Suggestions (per-hunk proposed edits) ----------------------------
// Same non-canonical, off-bundle, off-MCP discipline as comments. A
// suggestion is a proposed alternative markdown against a base version,
// decomposed into block-level hunks the reviewer accepts or rejects.

export const SUGGESTION_STATUSES = [
  "open",
  "applied",
  "rejected",
  "stale",
] as const;

export const suggestion = sqliteTable(
  "suggestion",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    documentSlug: text("document_slug").notNull(),
    baseDocVersion: integer("base_doc_version").notNull(),
    proposedMarkdown: text("proposed_markdown").notNull(),
    status: text("status", { enum: SUGGESTION_STATUSES }).notNull(),
    createdBy: text("created_by").notNull(),
    // The transport the proposal arrived through, recorded at write time
    // (default covers the ADD COLUMN migration + any direct insert; real
    // paths set it explicitly — web fn → web, MCP suggestEdit → mcp).
    channel: text("channel", { enum: CALLER_CHANNELS })
      .notNull()
      .default("web"),
    createdAt: text("created_at").notNull(),
    resolvedBy: text("resolved_by"),
    resolvedAt: text("resolved_at"),
    // Human-facing outcome metadata returned to the originating agent.
    // The version is set only when an apply creates a canonical version;
    // the note is optional on apply/reject and remains null for stale rows.
    resultDocVersion: integer("result_doc_version"),
    reviewerNote: text("reviewer_note"),
    // Create-proposals only (baseDocVersion === 0 — a real document's head
    // is never below 1, so 0 is the airtight discriminant): the Corpus path
    // the proposed document should be created at (null = project root with
    // the slug-derived filename), and the proposing connection's bound
    // Collection, so a human apply attaches the created document back into
    // the collection the agent was working in.
    proposedPath: text("proposed_path"),
    originCollectionSlug: text("origin_collection_slug"),
  },
  (t) => [
    index("suggestion_doc").on(t.documentSlug),
    check(
      "suggestion_status_valid",
      sql.raw(
        `status in (${SUGGESTION_STATUSES.map((s) => `'${s}'`).join(", ")})`,
      ),
    ),
  ],
);

export const HUNK_DECISIONS = ["pending", "accepted", "rejected"] as const;

export const suggestionHunk = sqliteTable(
  "suggestion_hunk",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    suggestionId: integer("suggestion_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    op: text("op", { enum: HUNK_OPS }).notNull(),
    baseStart: integer("base_start").notNull(),
    baseEnd: integer("base_end").notNull(),
    proposedText: text("proposed_text").notNull(),
    decision: text("decision", { enum: HUNK_DECISIONS }).notNull(),
  },
  (t) => [
    index("suggestion_hunk_suggestion").on(t.suggestionId),
    check(
      "suggestion_hunk_op_valid",
      sql.raw(`op in (${HUNK_OPS.map((s) => `'${s}'`).join(", ")})`),
    ),
    check(
      "suggestion_hunk_decision_valid",
      sql.raw(
        `decision in (${HUNK_DECISIONS.map((s) => `'${s}'`).join(", ")})`,
      ),
    ),
  ],
);

// A proposal-scoped conversation between its proposer and human reviewers.
// This is deliberately separate from anchored document comments: MCP callers
// can only see/reply to the proposals they created, never the document's
// general review threads.
export const suggestionMessage = sqliteTable(
  "suggestion_message",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    suggestionId: integer("suggestion_id").notNull(),
    body: text("body").notNull(),
    createdBy: text("created_by").notNull(),
    channel: text("channel", { enum: CALLER_CHANNELS }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("suggestion_message_suggestion").on(t.suggestionId)],
);

export type SuggestionRow = Readonly<typeof suggestion.$inferSelect>;
export type NewSuggestion = Readonly<typeof suggestion.$inferInsert>;
export type SuggestionStatus = SuggestionRow["status"];
export type SuggestionHunkRow = Readonly<typeof suggestionHunk.$inferSelect>;
export type NewSuggestionHunk = Readonly<typeof suggestionHunk.$inferInsert>;
export type HunkDecision = SuggestionHunkRow["decision"];
export type SuggestionMessageRow = Readonly<
  typeof suggestionMessage.$inferSelect
>;
export type NewSuggestionMessage = Readonly<
  typeof suggestionMessage.$inferInsert
>;

export type LedgerDb = DrizzleSqliteDODatabase<{
  contentBlobs: typeof contentBlobs;
  changeEvents: typeof changeEvents;
  instrumentationOutbox: typeof instrumentationOutbox;
  documentBlockMap: typeof documentBlockMap;
  documentBlockSeq: typeof documentBlockSeq;
  commentThread: typeof commentThread;
  comment: typeof comment;
  suggestion: typeof suggestion;
  suggestionHunk: typeof suggestionHunk;
  suggestionMessage: typeof suggestionMessage;
}>;

// The DDL for these tables is not hand-written: the table definitions
// above are the single source, and `pnpm db:generate:do` (drizzle-kit,
// driver "durable-sqlite") emits the migration bundle in `drizzle-do/`.
// The Drizzle DO migrator applies it at ProjectStore init — outside any
// TypeGraph enlisted transaction (the #135 constraint). See
// src/project-store.ts `ensureStore` and drizzle.do.config.ts.
