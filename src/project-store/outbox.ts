import { eventLogFor } from "../control/event-log-for";
import type { ProjectId } from "../ids";
import {
  encodeEvent,
  eventType as eventTypeOf,
  idempotencyKey,
  INSTRUMENTATION_EVENT_SCHEMA_VERSION,
  type InstrumentationEvent,
} from "../store/domain/instrumentation-events";
import type { InstrumentationOutbox } from "../store/repos/instrumentation-outbox";

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
        idempotencyKey: idempotencyKey(event),
        eventType: eventTypeOf(event),
        payload: encodeEvent(event),
        createdAt: change.changedAt,
      });
    }
  }

  async drain(): Promise<void> {
    this.drainPromise ??= this.drainOnce().finally(() => {
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

  private async drainOnce(): Promise<void> {
    let rows: Awaited<ReturnType<InstrumentationOutbox["next"]>>;
    try {
      const u = await this.deps.read();
      rows = await u.outbox.next();
    } catch (err) {
      console.error("[project-store] event-stream outbox read failed", err);
      await this.scheduleRetry();
      return;
    }
    for (const row of rows) {
      try {
        await eventLogFor(this.deps.env, this.deps.projectId()).append({
          schemaVersion: row.schemaVersion,
          projectId: row.projectId,
          idempotencyKey: row.idempotencyKey,
          eventType: row.eventType,
          payload: row.payload,
        });
        await this.deleteOutboxRow(row.id);
      } catch (err) {
        console.error("[project-store] event-stream outbox drain failed", err);
        try {
          await this.markOutboxRowFailed(row.id);
        } catch (markErr) {
          console.error(
            "[project-store] event-stream outbox mark failed",
            markErr,
          );
        }
        await this.scheduleRetry();
        return;
      }
    }
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
