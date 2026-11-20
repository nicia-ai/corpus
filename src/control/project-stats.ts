import { inArray } from "drizzle-orm";
import { z } from "zod";

import { AppError, type ErrorKind } from "../errors";
import { asProjectId, type ProjectId } from "../ids";
import {
  PROJECT_STATS_SCHEMA_VERSION,
  type ProjectStats,
} from "../store/domain/project-stats";

import { ACCESSIBLE_STATUSES } from "./access";
import { connectControlDb } from "./db";
import { project, projectStats } from "./schema/app";
import { storeFor } from "./store-for";

// UTC hour of the hourly cron tick that also refreshes stats (once a day).
export const PROJECT_STATS_REFRESH_UTC_HOUR = 3;

export type StatsRefreshOutcome = Readonly<
  { ok: true; computedAt: number } | { ok: false; errorKind: ErrorKind }
>;

const count = z.number().int().nonnegative();

export const projectStatsSchema: z.ZodType<ProjectStats> = z.object({
  documents: z.object({
    total: count,
    live: count,
    archived: count,
    inNoCorpus: count,
    inOneCorpus: count,
    inTwoOrMoreCorpora: count,
  }),
  corpora: z.object({
    total: count,
    withDirectDocuments: count,
    withFolderInclusions: count,
    withBothInclusionKinds: count,
    withDocumentViaBoth: count,
    defaultPresent: z.boolean(),
    defaultMembers: count,
    maxMembers: count,
    totalMembers: count,
  }),
  perCorpus: z.array(
    z.object({
      members: count,
      distinctTopLevelFolders: count,
      distinctParentFolders: count,
      membersAtRoot: count,
      coreMembers: count,
      referenceMembers: count,
      orderDiffersFromLexicalPath: z.boolean(),
    }),
  ),
  folders: z.object({
    total: count,
    maxDepth: count,
    topLevel: count,
    includedByTwoOrMoreCorpora: count,
  }),
  sameFilenamePairsAcrossCorpora: count,
  layout: z.object({
    corporaWithRoot: count,
    documentsOutsideRoots: count,
    legacyDirectLinks: count,
    legacyFolderLinks: count,
  }),
  links: z.object({ resolved: count, crossCorpus: count }),
});

// Where a snapshot comes from. Production reads the project's DO; tests
// inject a source that fails for one project.
export type StatsSource = (projectId: ProjectId) => Promise<ProjectStats>;

function doStatsSource(env: Env): StatsSource {
  return (projectId) => storeFor(env, projectId).statsSnapshot();
}

export function isStatsRefreshTick(scheduledTime: number): boolean {
  return (
    new Date(scheduledTime).getUTCHours() === PROJECT_STATS_REFRESH_UTC_HOUR
  );
}

// The stored JSON, or undefined when absent, unparseable, or written under
// another schema version (the page then shows "stale schema", not guesses).
export function parseStoredStats(
  row: Readonly<{ schemaVersion: number; statsJson: string | null }>,
): ProjectStats | undefined {
  if (
    row.statsJson === null ||
    row.schemaVersion !== PROJECT_STATS_SCHEMA_VERSION
  ) {
    return undefined;
  }
  try {
    const parsed = projectStatsSchema.safeParse(JSON.parse(row.statsJson));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function errorKindOf(error: unknown): ErrorKind {
  return error instanceof AppError ? error.kind : "internal";
}

// Recompute one project's snapshot in its DO and upsert the D1 row. A
// failure is recorded (error kind only) and returned, never thrown: the
// previous successful snapshot stays on the row.
export async function refreshProjectStats(
  env: Env,
  projectId: ProjectId,
  now: number = Date.now(),
  source: StatsSource = doStatsSource(env),
): Promise<StatsRefreshOutcome> {
  const db = connectControlDb(env.DB);
  try {
    const stats = await source(projectId);
    const fresh = {
      schemaVersion: PROJECT_STATS_SCHEMA_VERSION,
      statsJson: JSON.stringify(stats),
      computedAt: new Date(now),
      attemptedAt: new Date(now),
      errorKind: null,
    };
    await db
      .insert(projectStats)
      .values({ projectId, ...fresh })
      .onConflictDoUpdate({ target: projectStats.projectId, set: fresh });
    return { ok: true, computedAt: now };
  } catch (error) {
    const errorKind = errorKindOf(error);
    console.error("[project-stats] refresh failed", projectId, error);
    await db
      .insert(projectStats)
      .values({
        projectId,
        schemaVersion: PROJECT_STATS_SCHEMA_VERSION,
        attemptedAt: new Date(now),
        errorKind,
      })
      .onConflictDoUpdate({
        target: projectStats.projectId,
        set: { attemptedAt: new Date(now), errorKind },
      });
    return { ok: false, errorKind };
  }
}

// Cron sweep: every live project, sequentially (one DO read at a time keeps
// the daily job cheap), each isolated from the others' failures.
export async function refreshAllProjectStats(
  env: Env,
  now: number = Date.now(),
  source: StatsSource = doStatsSource(env),
): Promise<Readonly<{ refreshed: number; failed: number }>> {
  const rows = await connectControlDb(env.DB)
    .select({ id: project.id })
    .from(project)
    .where(inArray(project.status, ACCESSIBLE_STATUSES));
  let refreshed = 0;
  let failed = 0;
  for (const row of rows) {
    const outcome = await refreshProjectStats(
      env,
      asProjectId(row.id),
      now,
      source,
    );
    if (outcome.ok) refreshed += 1;
    else failed += 1;
  }
  return { refreshed, failed };
}
