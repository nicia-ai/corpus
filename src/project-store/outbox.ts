import { eventLogFor } from "../control/event-log-for";
import type { ProjectId } from "../ids";
import {
  encodeEvent,
  eventType as eventTypeOf,
  idempotencyKey,
  INSTRUMENTATION_EVENT_SCHEMA_VERSION,
  type InstrumentationEvent,
} from "../store/domain/instrumentation-events";
import {
  DEFAULT_DRAIN_LIMIT,
  type InstrumentationOutbox,
} from "../store/repos/instrumentation-outbox";

import { isDocumentChange, type DomainChange } from "./command";
import {
  collectionInstrumentationEvent,
  documentInstrumentationEvent,
} from "./instrumentation";
import type { ProjectUnit } from "./unit";

type ProjectInstrumentationDeps = Readonly<{
  env: Env;
  projectId: () => ProjectId;
  read: () => Promise<ProjectUnit>;
  write: <T>(fn: (u: ProjectUnit) => Promise<T>) => Promise<T>;
  scheduleAlarm: () => Promise<void>;
}>;

export class ProjectInstrumentation {
  private drainPromise: Promise<void> | undefined;
  private rerunRequested = false;

  constructor(private readonly deps: ProjectInstrumentationDeps) {}

  async emit(event: InstrumentationEvent): Promise<boolean> {
    try {
      await eventLogFor(this.deps.env, this.deps.projectId()).append({
        schemaVersion: INSTRUMENTATION_EVENT_SCHEMA_VERSION,
        projectId: this.deps.projectId(),
        idempotencyKey: idempotencyKey(event),
        eventType: eventTypeOf(event),
        payload: encodeEvent(event),
      });
      return true;
    } catch (err) {
      console.error("[project-store] event-stream append failed", err);
      return false;
    }
  }

  async recordChanges(
    u: ProjectUnit,
    changes: readonly DomainChange[],
  ): Promise<void> {
    for (const change of changes) {
      const localEventId = isDocumentChange(change)
        ? await u.log.append(change)
        : await u.log.appendCollection(change);
      const event = this.eventForChange(change);
      await u.outbox.enqueue({
        localEventId,
        schemaVersion: INSTRUMENTATION_EVENT_SCHEMA_VERSION,
        projectId: this.deps.projectId(),
        // `localEventId` (the ledger row) is this mutation's unique identity,
        // so distinct edits never collapse — while a drain retry reuses the
        // stored key and still dedups. See idempotencyKey for which event
        // kinds rely on it (head-only renames, collection.updated).
        idempotencyKey: idempotencyKey(event, localEventId),
        eventType: eventTypeOf(event),
        payload: encodeEvent(event),
        createdAt: change.changedAt,
      });
    }
  }

  async drain(): Promise<void> {
    if (this.drainPromise !== undefined) {
      // A write committed while a drain is in flight; the running loop may
      // have snapshotted its batch before this row landed, so ask it to make
      // another pass rather than letting this row wait for the next trigger.
      this.rerunRequested = true;
      return this.drainPromise;
    }
    this.drainPromise = this.drainLoop().finally(() => {
      this.drainPromise = undefined;
    });
    return this.drainPromise;
  }

  private eventForChange(change: DomainChange): InstrumentationEvent {
    return isDocumentChange(change)
      ? documentInstrumentationEvent(change)
      : collectionInstrumentationEvent(change);
  }

  private async deleteOutboxRow(id: number): Promise<void> {
    await this.deps.write((u) => u.outbox.delete(id));
  }

  private async markOutboxRowFailed(id: number): Promise<void> {
    await this.deps.write((u) => u.outbox.markFailed(id));
  }

  private async drainLoop(): Promise<void> {
    for (;;) {
      const status = await this.drainBatch();
      // "failed" already scheduled a retry alarm; stop and let it resume.
      if (status === "failed") return;
      // A full batch may have left a tail; keep going.
      if (status === "more") continue;
      // Empty — stop unless a write landed mid-drain and asked for another
      // pass (consumeRerun also clears the flag for the next iteration).
      if (!this.consumeRerun()) return;
    }
  }

  private consumeRerun(): boolean {
    if (!this.rerunRequested) return false;
    this.rerunRequested = false;
    return true;
  }

  private async drainBatch(): Promise<"empty" | "more" | "failed"> {
    let rows: Awaited<ReturnType<InstrumentationOutbox["next"]>>;
    try {
      const u = await this.deps.read();
      rows = await u.outbox.next();
    } catch (err) {
      console.error("[project-store] event-stream outbox read failed", err);
      await this.scheduleRetry();
      return "failed";
    }
    if (rows.length === 0) return "empty";

    // Skip-and-continue: a row that fails to append does NOT block the rows
    // behind it (no head-of-line stall). Attempts are counted only when some
    // OTHER row in the batch succeeded — that isolates a genuine poison row
    // (eventually dead-lettered by `next()`'s attempt cap) from a transient
    // EventLogStore outage (whole batch fails → retried later, never
    // dead-lettered, no event lost).
    const failedIds: number[] = [];
    let anySucceeded = false;
    for (const row of rows) {
      try {
        await eventLogFor(this.deps.env, this.deps.projectId()).append({
          schemaVersion: row.schemaVersion,
          projectId: row.projectId,
          idempotencyKey: row.idempotencyKey,
          eventType: row.eventType,
          payload: row.payload,
          occurredAt: row.createdAt,
        });
        await this.deleteOutboxRow(row.id);
        anySucceeded = true;
      } catch (err) {
        console.error("[project-store] event-stream outbox drain failed", err);
        failedIds.push(row.id);
      }
    }

    if (failedIds.length > 0) {
      if (anySucceeded) {
        for (const id of failedIds) {
          try {
            await this.markOutboxRowFailed(id);
          } catch (markErr) {
            console.error(
              "[project-store] event-stream outbox mark failed",
              markErr,
            );
          }
        }
      }
      await this.scheduleRetry();
      return "failed";
    }
    return rows.length >= DEFAULT_DRAIN_LIMIT ? "more" : "empty";
  }

  private async scheduleRetry(): Promise<void> {
    try {
      await this.deps.scheduleAlarm();
    } catch (alarmErr) {
      console.error(
        "[project-store] event-stream outbox alarm failed",
        alarmErr,
      );
    }
  }
}
