import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { blob, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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

export type LedgerDb = DrizzleSqliteDODatabase<{
  contentBlobs: typeof contentBlobs;
  changeEvents: typeof changeEvents;
  instrumentationOutbox: typeof instrumentationOutbox;
}>;

// The DDL for these tables is not hand-written: the table definitions
// above are the single source, and `pnpm db:generate:do` (drizzle-kit,
// driver "durable-sqlite") emits the migration bundle in `drizzle-do/`.
// The Drizzle DO migrator applies it at ProjectStore init — outside any
// TypeGraph enlisted transaction (the #135 constraint). See
// src/project-store.ts `ensureStore` and drizzle.do.config.ts.
