// Per-Project EventLogStore Durable Object. Holds the append-only
// instrumentation event stream in its OWN SQLite (separate storage
// budget from `ProjectStore`'s app data). Single source of truth for
// "what each agent read, and when" — the auditability promise.

import { DurableObject } from "cloudflare:workers";
import { asc, count as sqlCount, eq, gt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import { ledgerMigrations } from "../drizzle-event-log/migrations";

import { eventLog, type EventLogDb } from "./event-log-db";

// Envelope mandatory on every row: schema-version, project id,
// monotonic id, idempotency key, timestamp. Consumers read by ascending
// monotonic id from a cursor, deduping on idempotency key. `payload` is
// the JSON-encoded typed event (Zod-validated at the write boundary).
export type EventEnvelope = Readonly<{
  monotonicId: number;
  schemaVersion: number;
  projectId: string;
  idempotencyKey: string;
  eventType: string;
  timestamp: string;
  payload: string;
}>;

// Caller-supplied portion. The DO assigns `monotonicId` (PK
// autoincrement). `occurredAt` is when the underlying mutation happened
// (the change's `changedAt`); the DO falls back to wall-clock at append for
// callers that have no meaningful occurrence time (e.g. read events). This
// keeps the stored timestamp the edit time, not a delayed/retried drain time.
export type EventAppendInput = Readonly<{
  schemaVersion: number;
  projectId: string;
  idempotencyKey: string;
  eventType: string;
  payload: string;
  occurredAt?: string;
}>;

// Iterate window. `sinceMonotonicId` is exclusive ("events after this
// cursor"); `limit` caps the page. The consumer owns its offset; the
// DO holds no per-consumer delivery state.
export type IterateOpts = Readonly<{
  sinceMonotonicId?: number;
  limit?: number;
}>;

export type EventLogUsageSnapshot = Readonly<{
  events: number;
  storedEventBytes: number;
}>;

const DEFAULT_PAGE = 200;
const MAX_PAGE = 1000;

// Drizzle on do-sqlite returns a structurally typed handle; we tag it
// with the schema we know lives in this DO's storage so the SQL builder
// sees `eventLog`. One of the sanctioned casts (see AGENTS.md).
function asEventLogDb(handle: unknown): EventLogDb {
  return handle as EventLogDb;
}

export class EventLogStore extends DurableObject<Env> {
  private initPromise: Promise<EventLogDb> | undefined;

  // Lazy idempotent init: apply the schema migration bundle on first
  // touch, then cache the db handle for the DO's lifetime.
  private async db(): Promise<EventLogDb> {
    return (this.initPromise ??= (async () => {
      const handle = asEventLogDb(drizzle(this.ctx.storage));
      await migrate(handle, ledgerMigrations);
      return handle;
    })());
  }

  // Append one event. Returns the assigned monotonic id, or the
  // existing row's id if the idempotency key collides (retry-safe).
  async append(input: EventAppendInput): Promise<number> {
    const db = await this.db();
    const { occurredAt, ...row } = input;
    const timestamp = occurredAt ?? new Date().toISOString();
    // ON CONFLICT DO NOTHING + RETURNING gives us either the new id or
    // (on idempotency-key collision) nothing — in which case we look
    // up the prior row's id. Consumer cursoring is identical either
    // way: the same monotonic id surfaces for retries.
    const [inserted] = await db
      .insert(eventLog)
      .values({ ...row, timestamp })
      .onConflictDoNothing({ target: eventLog.idempotencyKey })
      .returning({ id: eventLog.monotonicId });
    if (inserted !== undefined) return inserted.id;
    const [prior] = await db
      .select({ id: eventLog.monotonicId })
      .from(eventLog)
      .where(eq(eventLog.idempotencyKey, input.idempotencyKey))
      .limit(1);
    return prior?.id ?? 0;
  }

  // Tear down all of this project's event-log storage (org-delete and
  // project-archive sweeps). Pairs with ProjectStore.purge() — both
  // DOs must be wiped together or the activity / instrumentation
  // history of a deleted project orphans here forever. Idempotent.
  async purge(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.initPromise = undefined;
  }

  // Cursor-driven iterate. Consumer-owned offset; the DO holds no
  // per-consumer delivery state. `limit` capped at MAX_PAGE so a wide
  // window can never lock the DO into a huge result.
  async iterate(opts: IterateOpts = {}): Promise<readonly EventEnvelope[]> {
    const db = await this.db();
    const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_PAGE, MAX_PAGE));
    const base = db
      .select({
        monotonicId: eventLog.monotonicId,
        schemaVersion: eventLog.schemaVersion,
        projectId: eventLog.projectId,
        idempotencyKey: eventLog.idempotencyKey,
        eventType: eventLog.eventType,
        timestamp: eventLog.timestamp,
        payload: eventLog.payload,
      })
      .from(eventLog);
    const rows =
      opts.sinceMonotonicId === undefined
        ? await base.orderBy(asc(eventLog.monotonicId)).limit(limit)
        : await base
            .where(gt(eventLog.monotonicId, opts.sinceMonotonicId))
            .orderBy(asc(eventLog.monotonicId))
            .limit(limit);
    return rows;
  }

  // Total event count — small helper for tests and the activity view's
  // "N events" badge. Cheap (single COUNT against an indexed PK).
  async count(): Promise<number> {
    const db = await this.db();
    const [row] = await db.select({ n: sqlCount() }).from(eventLog);
    return row?.n ?? 0;
  }

  // Logical UTF-8 bytes of the persisted event envelope. This is the
  // hosted quota unit; it intentionally tracks the event stream itself,
  // not SQLite page/index overhead.
  async usageSnapshot(): Promise<EventLogUsageSnapshot> {
    const db = await this.db();
    const [row] = await db
      .select({
        events: sql<number>`count(*)`,
        storedEventBytes: sql<number>`coalesce(sum(
          length(cast(${eventLog.projectId} as blob)) +
          length(cast(${eventLog.idempotencyKey} as blob)) +
          length(cast(${eventLog.eventType} as blob)) +
          length(cast(${eventLog.timestamp} as blob)) +
          length(cast(${eventLog.payload} as blob))
        ), 0)`,
      })
      .from(eventLog);
    return {
      events: row?.events ?? 0,
      storedEventBytes: row?.storedEventBytes ?? 0,
    };
  }
}
