import { asc, eq, sql } from "drizzle-orm";

import { instrumentationOutbox, type LedgerDb } from "../../db";

export type InstrumentationOutboxInsert = Readonly<{
  localEventId: number;
  schemaVersion: number;
  projectId: string;
  idempotencyKey: string;
  eventType: string;
  payload: string;
  createdAt: string;
}>;

export type InstrumentationOutboxRow = Readonly<{
  id: number;
  localEventId: number;
  schemaVersion: number;
  projectId: string;
  idempotencyKey: string;
  eventType: string;
  payload: string;
  createdAt: string;
  attemptCount: number;
}>;

const DEFAULT_DRAIN_LIMIT = 100;

export class InstrumentationOutbox {
  constructor(private readonly db: LedgerDb) {}

  enqueue(input: InstrumentationOutboxInsert): Promise<void> {
    return this.db
      .insert(instrumentationOutbox)
      .values(input)
      .then(() => undefined);
  }

  next(
    limit = DEFAULT_DRAIN_LIMIT,
  ): Promise<readonly InstrumentationOutboxRow[]> {
    return this.db
      .select({
        id: instrumentationOutbox.id,
        localEventId: instrumentationOutbox.localEventId,
        schemaVersion: instrumentationOutbox.schemaVersion,
        projectId: instrumentationOutbox.projectId,
        idempotencyKey: instrumentationOutbox.idempotencyKey,
        eventType: instrumentationOutbox.eventType,
        payload: instrumentationOutbox.payload,
        createdAt: instrumentationOutbox.createdAt,
        attemptCount: instrumentationOutbox.attemptCount,
      })
      .from(instrumentationOutbox)
      .orderBy(asc(instrumentationOutbox.id))
      .limit(Math.max(1, limit));
  }

  async delete(id: number): Promise<void> {
    await this.db
      .delete(instrumentationOutbox)
      .where(eq(instrumentationOutbox.id, id));
  }

  async markFailed(id: number): Promise<void> {
    await this.db
      .update(instrumentationOutbox)
      .set({
        attemptCount: sql`${instrumentationOutbox.attemptCount} + 1`,
      })
      .where(eq(instrumentationOutbox.id, id));
  }
}
