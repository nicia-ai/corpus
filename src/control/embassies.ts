import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";

import type { EmbassyGrant } from "../embassy/grant";
import {
  asDocumentSlug,
  asEmbassyId,
  asProjectId,
  type DocumentSlug,
  type EmbassyId,
  type ProjectId,
} from "../ids";

import type { ControlDb } from "./db";
import { embassy } from "./schema/app";

export type { EmbassyGrant };

export const EMBASSY_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const EMBASSY_WRITE_LIMIT = 30;
export const EMBASSY_FETCH_DEBOUNCE_MS = 60_000;

export type EmbassyView = Readonly<{
  id: EmbassyId;
  projectId: ProjectId;
  documentSlug: DocumentSlug;
  grant: EmbassyGrant;
  expiresAt: number;
  fetchCount: number;
  lastFetchedAt: number | undefined;
  writeCount: number;
}>;

function toView(row: typeof embassy.$inferSelect): EmbassyView {
  return {
    id: asEmbassyId(row.id),
    projectId: asProjectId(row.projectId),
    documentSlug: asDocumentSlug(row.documentSlug),
    grant: row.grant,
    expiresAt: row.expiresAt.getTime(),
    fetchCount: row.fetchCount,
    lastFetchedAt:
      row.lastFetchedAt === null ? undefined : row.lastFetchedAt.getTime(),
    writeCount: row.writeCount,
  };
}

function isLive(row: typeof embassy.$inferSelect, now: Date): boolean {
  if (row.revokedAt !== null) return false;
  return row.expiresAt.getTime() > now.getTime();
}

export async function mintEmbassy(
  db: ControlDb,
  input: Readonly<{
    projectId: ProjectId;
    documentSlug: DocumentSlug;
    grant: EmbassyGrant;
    ttlMs?: number;
  }>,
): Promise<EmbassyView> {
  const now = new Date();
  const ttl = input.ttlMs ?? EMBASSY_DEFAULT_TTL_MS;
  const [row] = await db
    .insert(embassy)
    .values({
      projectId: input.projectId,
      documentSlug: input.documentSlug,
      grant: input.grant,
      expiresAt: new Date(now.getTime() + ttl),
    })
    .returning();
  if (row === undefined) throw new Error("embassy insert returned no row");
  return toView(row);
}

export async function listEmbassiesForDocument(
  db: ControlDb,
  projectId: ProjectId,
  documentSlug: DocumentSlug,
): Promise<readonly EmbassyView[]> {
  const now = new Date();
  const rows = await db
    .select()
    .from(embassy)
    .where(
      and(
        eq(embassy.projectId, projectId),
        eq(embassy.documentSlug, documentSlug),
        isNull(embassy.revokedAt),
        gt(embassy.expiresAt, now),
      ),
    )
    .orderBy(desc(embassy.createdAt));
  return rows.map(toView);
}

export async function resolveLiveEmbassy(
  db: ControlDb,
  id: EmbassyId,
): Promise<EmbassyView | undefined> {
  const [row] = await db.select().from(embassy).where(eq(embassy.id, id));
  if (row === undefined) return undefined;
  if (!isLive(row, new Date())) return undefined;
  return toView(row);
}

export async function revokeEmbassy(
  db: ControlDb,
  input: Readonly<{ id: EmbassyId; projectId: ProjectId }>,
): Promise<void> {
  await db
    .update(embassy)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(embassy.id, input.id), eq(embassy.projectId, input.projectId)),
    );
}

export async function revokeEmbassiesForDocument(
  db: ControlDb,
  input: Readonly<{ projectId: ProjectId; documentSlug: DocumentSlug }>,
): Promise<void> {
  await db
    .update(embassy)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(embassy.projectId, input.projectId),
        eq(embassy.documentSlug, input.documentSlug),
        isNull(embassy.revokedAt),
      ),
    );
}

export async function noteEmbassyFetch(
  db: ControlDb,
  id: EmbassyId,
  lastFetchedAt: number | undefined,
): Promise<void> {
  const now = Date.now();
  if (
    lastFetchedAt !== undefined &&
    now - lastFetchedAt < EMBASSY_FETCH_DEBOUNCE_MS
  ) {
    return;
  }
  await db
    .update(embassy)
    .set({
      fetchCount: sql`${embassy.fetchCount} + 1`,
      lastFetchedAt: new Date(now),
    })
    .where(eq(embassy.id, id));
}

export async function recordEmbassyWrite(
  db: ControlDb,
  input: Readonly<{
    id: EmbassyId;
    flipGrantToSuggest?: boolean;
  }>,
): Promise<void> {
  await db
    .update(embassy)
    .set({
      writeCount: sql`${embassy.writeCount} + 1`,
      ...(input.flipGrantToSuggest === true
        ? { grant: "suggest" as const }
        : {}),
    })
    .where(
      and(
        eq(embassy.id, input.id),
        lt(embassy.writeCount, EMBASSY_WRITE_LIMIT),
      ),
    );
}
