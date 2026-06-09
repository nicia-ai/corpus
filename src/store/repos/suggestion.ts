import { and, eq, inArray, sql } from "drizzle-orm";

import {
  type HunkDecision,
  type LedgerDb,
  type NewSuggestion,
  type NewSuggestionHunk,
  suggestion,
  suggestionHunk,
  type SuggestionHunkRow,
  type SuggestionRow,
  type SuggestionStatus,
} from "../../db";

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
    if (rows.length === 0) return;
    await this.db.insert(suggestionHunk).values([...rows]);
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
  // forDoc() fan-out would be N reads for one list render.
  async openCountsByDoc(): Promise<Record<string, number>> {
    const rows = await this.db
      .select({ slug: suggestion.documentSlug, n: sql<number>`count(*)` })
      .from(suggestion)
      .where(eq(suggestion.status, "open"))
      .groupBy(suggestion.documentSlug);
    const out: Record<string, number> = {};
    for (const r of rows) out[r.slug] = r.n;
    return out;
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
    id: number,
    status: SuggestionStatus,
    resolvedBy: string,
    resolvedAt: string,
  ): Promise<void> {
    await this.db
      .update(suggestion)
      .set({ status, resolvedBy, resolvedAt })
      .where(eq(suggestion.id, id));
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
