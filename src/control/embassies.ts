import { and, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";

import { grantsAllowing, type EmbassyGrant } from "../embassy/grant";
import {
  asDocumentSlug,
  asEmbassyId,
  asProjectId,
  type DocumentSlug,
  type EmbassyId,
  type ProjectId,
} from "../ids";

import { ACCESSIBLE_STATUSES, isAccessible } from "./access";
import type { ControlDb } from "./db";
import { embassy, project } from "./schema/app";

export type { EmbassyGrant };

export const EMBASSY_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const EMBASSY_WRITE_LIMIT = 1000;
export const EMBASSY_FETCH_DEBOUNCE_MS = 60_000;
const EMBASSY_REVOKE_BATCH = 80;

export type EmbassyView = Readonly<{
  id: EmbassyId;
  projectId: ProjectId;
  documentSlug: DocumentSlug;
  label: string;
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
    label: row.label,
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
    label?: string;
    grant: EmbassyGrant;
    expiresAt?: number;
  }>,
): Promise<EmbassyView> {
  const expiresAt = input.expiresAt ?? Date.now() + EMBASSY_DEFAULT_TTL_MS;
  const [row] = await db
    .insert(embassy)
    .values({
      projectId: input.projectId,
      documentSlug: input.documentSlug,
      label: input.label ?? "Shared link",
      grant: input.grant,
      expiresAt: new Date(expiresAt),
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
  const [row] = await db
    .select()
    .from(embassy)
    .innerJoin(
      project,
      and(
        eq(project.id, embassy.projectId),
        inArray(project.status, ACCESSIBLE_STATUSES),
      ),
    )
    .where(eq(embassy.id, id));
  if (row === undefined || !isAccessible(row.project.status)) return undefined;
  if (!isLive(row.embassy, new Date())) return undefined;
  return toView(row.embassy);
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
  await revokeEmbassiesForDocuments(db, {
    projectId: input.projectId,
    documentSlugs: [input.documentSlug],
  });
}

export async function revokeEmbassiesForProject(
  db: ControlDb,
  projectId: ProjectId,
): Promise<void> {
  await db
    .update(embassy)
    .set({ revokedAt: new Date() })
    .where(and(eq(embassy.projectId, projectId), isNull(embassy.revokedAt)));
}

export async function revokeEmbassiesForDocuments(
  db: ControlDb,
  input: Readonly<{
    projectId: ProjectId;
    documentSlugs: readonly DocumentSlug[];
  }>,
): Promise<void> {
  const slugs = input.documentSlugs;
  for (let i = 0; i < slugs.length; i += EMBASSY_REVOKE_BATCH) {
    const batch = slugs.slice(i, i + EMBASSY_REVOKE_BATCH);
    await db
      .update(embassy)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(embassy.projectId, input.projectId),
          inArray(embassy.documentSlug, [...batch]),
          isNull(embassy.revokedAt),
        ),
      );
  }
}

export async function organizationIdForProject(
  db: ControlDb,
  projectId: ProjectId,
): Promise<string | undefined> {
  const [row] = await db
    .select({ organizationId: project.organizationId })
    .from(project)
    .where(eq(project.id, projectId));
  return row?.organizationId;
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

export async function setEmbassyGrant(
  db: ControlDb,
  input: Readonly<{ id: EmbassyId; projectId: ProjectId; grant: EmbassyGrant }>,
): Promise<EmbassyView | undefined> {
  const [row] = await db
    .update(embassy)
    .set({ grant: input.grant })
    .where(
      and(
        eq(embassy.id, input.id),
        eq(embassy.projectId, input.projectId),
        isNull(embassy.revokedAt),
        gt(embassy.expiresAt, new Date()),
      ),
    )
    .returning();
  return row === undefined ? undefined : toView(row);
}

export async function setEmbassyLabel(
  db: ControlDb,
  input: Readonly<{ id: EmbassyId; projectId: ProjectId; label: string }>,
): Promise<EmbassyView | undefined> {
  const [row] = await db
    .update(embassy)
    .set({ label: input.label })
    .where(
      and(
        eq(embassy.id, input.id),
        eq(embassy.projectId, input.projectId),
        isNull(embassy.revokedAt),
        gt(embassy.expiresAt, new Date()),
      ),
    )
    .returning();
  return row === undefined ? undefined : toView(row);
}

// Only a live link can be extended: a revoked or already-expired link stays
// dead, so an owner revoking is never undone by a late renewal.
export async function setEmbassyExpiry(
  db: ControlDb,
  input: Readonly<{ id: EmbassyId; projectId: ProjectId; expiresAt: number }>,
): Promise<EmbassyView | undefined> {
  const [row] = await db
    .update(embassy)
    .set({ expiresAt: new Date(input.expiresAt) })
    .where(
      and(
        eq(embassy.id, input.id),
        eq(embassy.projectId, input.projectId),
        isNull(embassy.revokedAt),
        gt(embassy.expiresAt, new Date()),
      ),
    )
    .returning();
  return row === undefined ? undefined : toView(row);
}

export async function reserveEmbassyWrite(
  db: ControlDb,
  input: Readonly<{ id: EmbassyId; needed: EmbassyGrant }>,
): Promise<boolean> {
  // The grant is re-checked in the same update as the reservation, so an
  // owner switching a link to suggest-only takes effect on the next write.
  const updated = await db
    .update(embassy)
    .set({ writeCount: sql`${embassy.writeCount} + 1` })
    .where(
      and(
        eq(embassy.id, input.id),
        inArray(embassy.grant, [...grantsAllowing(input.needed)]),
        isNull(embassy.revokedAt),
        gt(embassy.expiresAt, new Date()),
        lt(embassy.writeCount, EMBASSY_WRITE_LIMIT),
      ),
    )
    .returning({ id: embassy.id });
  return updated.length > 0;
}

export async function releaseEmbassyWrite(
  db: ControlDb,
  id: EmbassyId,
): Promise<void> {
  await db
    .update(embassy)
    .set({ writeCount: sql`${embassy.writeCount} - 1` })
    .where(and(eq(embassy.id, id), gt(embassy.writeCount, 0)));
}
