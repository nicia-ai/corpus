import { and, eq, inArray, ne, sql } from "drizzle-orm";

import {
  type HunkDecision,
  type LedgerDb,
  type NewSuggestion,
  type NewSuggestionHunk,
  type NewSuggestionMessage,
  suggestion,
  suggestionHunk,
  suggestionMessage,
  type SuggestionHunkRow,
  type SuggestionMessageRow,
  type SuggestionRow,
  type SuggestionStatus,
} from "../../db";
import { CREATE_PROPOSAL_BASE_VERSION } from "../domain/suggestion";

// Per-hunk suggestions, as a repository. Non-canonical review layer
// (off-bundle, off-MCP). All row/status types inferred from the schema, so
// an invalid status / op / decision cannot be written or queried.
export class SuggestionRepo {
  constructor(private readonly db: LedgerDb) {}

  async create(row: NewSuggestion): Promise<number> {
    const [r] = await this.db
      .insert(suggestion)
      .values(row)
      .returning({ id: suggestion.id });
    return r?.id ?? 0;
  }

  async addHunks(rows: readonly NewSuggestionHunk[]): Promise<void> {
    // SQLite-backed Durable Objects bind at most 100 parameters per query,
    // and each hunk row binds 9 values (suggestionId, ordinal, op,
    // baseStart, baseEnd, proposedText, propStart, propEnd, decision) —
    // 12+ hunks in one INSERT overflow the limit. Batch at ⌊100/9⌋ = 11
    // rows; addHunks always runs inside the DO write transaction, so the
    // batches stay atomic.
    const BATCH = 11;
    for (let i = 0; i < rows.length; i += BATCH) {
      await this.db.insert(suggestionHunk).values(rows.slice(i, i + BATCH));
    }
  }

  async addMessage(row: NewSuggestionMessage): Promise<number> {
    const [r] = await this.db
      .insert(suggestionMessage)
      .values(row)
      .returning({ id: suggestionMessage.id });
    if (r === undefined) {
      throw new Error("Suggestion message insert returned no id.");
    }
    return r.id;
  }

  messagesForSuggestions(
    ids: readonly number[],
  ): Promise<readonly SuggestionMessageRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.db
      .select()
      .from(suggestionMessage)
      .where(inArray(suggestionMessage.suggestionId, [...ids]))
      .orderBy(suggestionMessage.id);
  }

  forDoc(documentSlug: string): Promise<readonly SuggestionRow[]> {
    return this.db
      .select()
      .from(suggestion)
      .where(eq(suggestion.documentSlug, documentSlug))
      .orderBy(suggestion.id);
  }

  // Count of OPEN suggestions per document in one grouped query — the
  // documents-list badge needs every doc's count at once, and a per-row
  // forDoc() fan-out would be N reads for one list render. Create-proposals
  // (baseDocVersion 0) are excluded: they are not edits to a document, and
  // the review surface lists them separately (openCreates).
  async openCountsByDoc(): Promise<Record<string, number>> {
    const rows = await this.db
      .select({ slug: suggestion.documentSlug, n: sql<number>`count(*)` })
      .from(suggestion)
      .where(
        and(
          eq(suggestion.status, "open"),
          ne(suggestion.baseDocVersion, CREATE_PROPOSAL_BASE_VERSION),
        ),
      )
      .groupBy(suggestion.documentSlug);
    const out: Record<string, number> = {};
    for (const r of rows) out[r.slug] = r.n;
    return out;
  }

  // Open create-proposals (baseDocVersion 0 — see db.ts discriminant),
  // oldest first so the review list reads in proposal order.
  openCreates(): Promise<readonly SuggestionRow[]> {
    return this.db
      .select()
      .from(suggestion)
      .where(
        and(
          eq(suggestion.status, "open"),
          eq(suggestion.baseDocVersion, CREATE_PROPOSAL_BASE_VERSION),
        ),
      )
      .orderBy(suggestion.id);
  }

  async get(id: number): Promise<SuggestionRow | undefined> {
    const [r] = await this.db
      .select()
      .from(suggestion)
      .where(eq(suggestion.id, id))
      .limit(1);
    return r;
  }

  hunksFor(suggestionId: number): Promise<readonly SuggestionHunkRow[]> {
    return this.db
      .select()
      .from(suggestionHunk)
      .where(eq(suggestionHunk.suggestionId, suggestionId))
      .orderBy(suggestionHunk.ordinal);
  }

  async getHunk(id: number): Promise<SuggestionHunkRow | undefined> {
    const [r] = await this.db
      .select()
      .from(suggestionHunk)
      .where(eq(suggestionHunk.id, id))
      .limit(1);
    return r;
  }

  hunksForSuggestions(
    ids: readonly number[],
  ): Promise<readonly SuggestionHunkRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.db
      .select()
      .from(suggestionHunk)
      .where(inArray(suggestionHunk.suggestionId, [...ids]))
      .orderBy(suggestionHunk.ordinal);
  }

  async setHunkDecision(hunkId: number, decision: HunkDecision): Promise<void> {
    await this.db
      .update(suggestionHunk)
      .set({ decision })
      .where(eq(suggestionHunk.id, hunkId));
  }

  async resolve(
    input: Readonly<{
      id: number;
      status: SuggestionStatus;
      resolvedBy: string;
      resolvedAt: string;
      resultDocVersion?: number;
      reviewerNote?: string;
    }>,
  ): Promise<void> {
    await this.db
      .update(suggestion)
      .set({
        status: input.status,
        resolvedBy: input.resolvedBy,
        resolvedAt: input.resolvedAt,
        resultDocVersion: input.resultDocVersion ?? null,
        reviewerNote: input.reviewerNote ?? null,
      })
      .where(eq(suggestion.id, input.id));
  }

  async markStale(id: number): Promise<void> {
    await this.db
      .update(suggestion)
      .set({ status: "stale" })
      .where(eq(suggestion.id, id));
  }

  // Mark every still-open suggestion for a document stale. Called when the
  // document's head advances (e.g. a suggestion is applied): the others'
  // stored base source ranges no longer match the head, so they can't apply.
  async staleOpenForDoc(documentSlug: string): Promise<void> {
    await this.db
      .update(suggestion)
      .set({ status: "stale" })
      .where(
        and(
          eq(suggestion.documentSlug, documentSlug),
          eq(suggestion.status, "open"),
        ),
      );
  }
}
