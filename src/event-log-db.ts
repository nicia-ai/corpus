import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// The per-Project EventLogStore DO's single SQLite table. This DO has
// its OWN storage budget — separate from `ProjectStore` (documents,
// collections, blobs) — so durable instrumentation events never
// compete with canonical app data. Events are a shipped auditability
// feature, not sampled telemetry, so they must be durable; durability
// is safe here precisely because the budget is its own.
//
// The envelope fields are mandatory so a future cursor-driven consumer
// over this stream has the discipline it needs: schema-versioning for
// evolution, project_id for multi-tenant fan-out, monotonic_id for
// cursoring, idempotency_key for at-least-once-safe consumers, and a
// precise wall-clock timestamp.
//
// `event_type` is intentionally a string (e.g. "document.updated",
// "collection.attached", "read.first") rather than a closed enum so
// new event types can land without a DO migration; the Zod
// discriminated union over `payload` is what enforces shape.
export const eventLog = sqliteTable(
  "event_log",
  {
    monotonicId: integer("monotonic_id").primaryKey({ autoIncrement: true }),
    schemaVersion: integer("schema_version").notNull(),
    projectId: text("project_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    eventType: text("event_type").notNull(),
    timestamp: text("timestamp").notNull(),
    payload: text("payload").notNull(),
  },
  (t) => [
    // Idempotency dedup: a retried append with the same key MUST collapse
    // to the original row, not write a second event. Caller derives the
    // key from the underlying mutation (e.g. `(slug, docVersion)` for a
    // save) so retries within the same logical op are safe.
    uniqueIndex("event_log_idempotency_key_unique").on(t.idempotencyKey),
  ],
);

// The Drizzle DO migrator's `migrate(handle, bundle)` expects the
// unwrapped DrizzleSqliteDODatabase<...> shape, not a Readonly<...> of
// it; LedgerDb in src/db.ts follows the same pattern.
// eslint-disable-next-line functional/type-declaration-immutability
export type EventLogDb = DrizzleSqliteDODatabase<{
  eventLog: typeof eventLog;
}>;

// The DDL for this table is not hand-written: the definition above is
// the single source, and `pnpm db:generate:event-log` (drizzle-kit,
// driver "durable-sqlite") emits the migration bundle in
// `drizzle-event-log/`. The Drizzle DO migrator applies it at
// EventLogStore init, mirroring the ProjectStore pattern.
