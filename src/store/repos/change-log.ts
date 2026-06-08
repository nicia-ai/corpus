import { count, desc, lt, max } from "drizzle-orm";

import { changeEvents, type LedgerDb } from "../../db";
import { compact } from "../../util";
import type { CollectionChange, DocumentChange } from "../domain/change-events";

export type RecentChange = Readonly<{
  id: number;
  eventType: string;
  documentSlug: string | null;
  collectionSlug: string | null;
  beforeJson: string | null;
  afterJson: string | null;
  changedAt: string;
  changedBy: string;
}>;

const RECENT_CHANGES_MAX = 200;

// The append-only operational change-event log as a repository. This is
// NOT content lineage — version history is the DocumentVersion /
// CollectionVersion chain. Constructed with whichever do-sqlite handle is
// active so the same code is correct inside and outside a transaction.
// All Drizzle column noise lives here.
export class ChangeLog {
  constructor(private readonly db: LedgerDb) {}

  private async insert(row: typeof changeEvents.$inferInsert): Promise<number> {
    const [evt] = await this.db
      .insert(changeEvents)
      .values(row)
      .returning({ id: changeEvents.id });
    return evt?.id ?? 0;
  }

  // Returns the new event id so callers can correlate downstream
  // (audit, future stream consumers). Domain change → columns + JSON
  // encoding is the repo's job.
  append(change: DocumentChange): Promise<number> {
    return this.insert({
      eventType: change.kind,
      documentSlug: change.slug,
      collectionSlug: null,
      beforeJson: null,
      afterJson: JSON.stringify(
        compact({
          docVersion: change.docVersion,
          title: change.title,
          // Durable origin link when this save applied a suggestion (omitted
          // for ordinary edits).
          appliedFrom: change.appliedFrom,
        }),
      ),
      changedAt: change.changedAt,
      changedBy: change.changedBy,
    });
  }

  appendCollection(change: CollectionChange): Promise<number> {
    return this.insert({
      eventType: change.kind,
      documentSlug: change.documentSlug ?? null,
      collectionSlug: change.collectionSlug,
      beforeJson:
        change.before === undefined ? null : JSON.stringify(change.before),
      afterJson:
        change.after === undefined ? null : JSON.stringify(change.after),
      changedAt: change.changedAt,
      changedBy: change.changedBy,
    });
  }

  recent(limit: number): Promise<readonly RecentChange[]> {
    return this.db
      .select({
        id: changeEvents.id,
        eventType: changeEvents.eventType,
        documentSlug: changeEvents.documentSlug,
        collectionSlug: changeEvents.collectionSlug,
        beforeJson: changeEvents.beforeJson,
        afterJson: changeEvents.afterJson,
        changedAt: changeEvents.changedAt,
        changedBy: changeEvents.changedBy,
      })
      .from(changeEvents)
      .orderBy(desc(changeEvents.id))
      .limit(Math.max(1, Math.min(limit, RECENT_CHANGES_MAX)));
  }

  async lastEventId(): Promise<number> {
    const [row] = await this.db
      .select({ m: max(changeEvents.id) })
      .from(changeEvents);
    return row?.m ?? 0;
  }

  // Retention: drop operational events older than the window. This is
  // delivery state, not content lineage — safe to prune wholesale.
  async deleteOlderThan(cutoffIso: string): Promise<number> {
    const [before] = await this.db
      .select({ n: count() })
      .from(changeEvents)
      .where(lt(changeEvents.changedAt, cutoffIso));
    const n = before?.n ?? 0;
    if (n > 0) {
      await this.db
        .delete(changeEvents)
        .where(lt(changeEvents.changedAt, cutoffIso));
    }
    return n;
  }
}
