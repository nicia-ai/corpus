import { and, asc, eq, gt, isNull, lt, ne, or, sql } from "drizzle-orm";

import { type LedgerDb, mirrorState, type MirrorStateRow } from "../../db";
import type { CorpusSlug } from "../../ids";
import { MAX_SYNC_ATTEMPTS } from "../domain/git-mirror";

export type MirrorAuthor = Readonly<{ changedBy: string; changedAt: string }>;

// "Something is owed" — the rows a drain pass works on. Exhausted rows (too
// many failed passes) are excluded until a new change or an owner rebuild
// resets their attempts.
const owed = sql`(${mirrorState.generation} > ${mirrorState.syncedGeneration} or ${mirrorState.intent} != 'sync')`;

// The mirror's per-corpus ledger. Writes that record a change run on the
// transaction-scoped ledger inside ProjectStore.write(); everything the drain
// does afterwards runs on the storage handle.
export class MirrorStateRepo {
  constructor(private readonly db: LedgerDb) {}

  async find(corpusSlug: CorpusSlug): Promise<MirrorStateRow | undefined> {
    const [row] = await this.db
      .select()
      .from(mirrorState)
      .where(eq(mirrorState.corpusSlug, corpusSlug));
    return row;
  }

  all(): Promise<readonly MirrorStateRow[]> {
    return this.db
      .select()
      .from(mirrorState)
      .orderBy(asc(mirrorState.corpusSlug));
  }

  // A change to the corpus's documents: tick the generation and credit the
  // next commit to its author. A corpus recreated after a delete is a plain
  // sync again; a pending rebuild stays a rebuild.
  async recordChange(
    corpusSlug: CorpusSlug,
    author: MirrorAuthor,
  ): Promise<void> {
    await this.db
      .insert(mirrorState)
      .values({ corpusSlug, generation: 1, ...author })
      .onConflictDoUpdate({
        target: mirrorState.corpusSlug,
        set: {
          generation: sql`${mirrorState.generation} + 1`,
          intent: sql`case when ${mirrorState.intent} = 'delete' then 'sync' else ${mirrorState.intent} end`,
          attempts: 0,
          retryAt: null,
          ...author,
        },
      });
  }

  // Discard the repository and rebuild it from the corpus as it is now.
  async requestRebuild(
    corpusSlug: CorpusSlug,
    author: MirrorAuthor,
  ): Promise<void> {
    await this.db
      .insert(mirrorState)
      .values({ corpusSlug, intent: "rebuild", generation: 1, ...author })
      .onConflictDoUpdate({
        target: mirrorState.corpusSlug,
        set: {
          intent: "rebuild",
          generation: sql`${mirrorState.generation} + 1`,
          attempts: 0,
          retryAt: null,
          lastError: null,
          ...author,
        },
      });
  }

  // The corpus is gone: the repository goes with it.
  async requestDelete(
    corpusSlug: CorpusSlug,
    author: MirrorAuthor,
  ): Promise<void> {
    await this.db
      .insert(mirrorState)
      .values({ corpusSlug, intent: "delete", generation: 1, ...author })
      .onConflictDoUpdate({
        target: mirrorState.corpusSlug,
        set: {
          intent: "delete",
          generation: sql`${mirrorState.generation} + 1`,
          attempts: 0,
          retryAt: null,
          ...author,
        },
      });
  }

  // Rows owed a pass and due now (`retryAt` reached), oldest corpus first.
  dueAt(nowMs: number): Promise<readonly MirrorStateRow[]> {
    return this.db
      .select()
      .from(mirrorState)
      .where(
        and(
          owed,
          lt(mirrorState.attempts, MAX_SYNC_ATTEMPTS),
          or(isNull(mirrorState.retryAt), lt(mirrorState.retryAt, nowMs + 1)),
        ),
      )
      .orderBy(asc(mirrorState.corpusSlug));
  }

  // The earliest moment a not-yet-due row becomes due, for the next alarm.
  async nextRetryAfter(nowMs: number): Promise<number | undefined> {
    const [row] = await this.db
      .select({ at: sql<number | null>`min(${mirrorState.retryAt})` })
      .from(mirrorState)
      .where(
        and(
          owed,
          lt(mirrorState.attempts, MAX_SYNC_ATTEMPTS),
          gt(mirrorState.retryAt, nowMs),
        ),
      );
    return row?.at ?? undefined;
  }

  // The pass consumed a rebuild request: from here a failure is retried as an
  // ordinary sync, which recreates a missing repository on its own.
  async consumeRebuild(corpusSlug: CorpusSlug): Promise<void> {
    await this.db
      .update(mirrorState)
      .set({ intent: "sync" })
      .where(
        and(
          eq(mirrorState.corpusSlug, corpusSlug),
          ne(mirrorState.intent, "delete"),
        ),
      );
  }

  // The repository now reflects everything up to `generation`.
  async markSynced(
    corpusSlug: CorpusSlug,
    done: Readonly<{ generation: number; commit: string; at: string }>,
  ): Promise<void> {
    await this.db
      .update(mirrorState)
      .set({
        syncedGeneration: done.generation,
        lastCommit: done.commit,
        lastSyncedAt: done.at,
        attempts: 0,
        retryAt: null,
        lastError: null,
      })
      .where(eq(mirrorState.corpusSlug, corpusSlug));
  }

  // The pass failed: remember why, count it, and say when to try again.
  async markFailed(
    corpusSlug: CorpusSlug,
    failure: Readonly<{ error: string; retryAt: number }>,
  ): Promise<void> {
    await this.db
      .update(mirrorState)
      .set({
        attempts: sql`${mirrorState.attempts} + 1`,
        retryAt: failure.retryAt,
        lastError: failure.error,
      })
      .where(eq(mirrorState.corpusSlug, corpusSlug));
  }

  // The repository is gone; forget the row unless the corpus came back
  // (a newer generation) while it was being deleted.
  async deleteIfUnchanged(
    corpusSlug: CorpusSlug,
    generation: number,
  ): Promise<void> {
    await this.db
      .delete(mirrorState)
      .where(
        and(
          eq(mirrorState.corpusSlug, corpusSlug),
          eq(mirrorState.generation, generation),
          eq(mirrorState.intent, "delete"),
        ),
      );
  }
}
