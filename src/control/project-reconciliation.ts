import { and, eq, inArray } from "drizzle-orm";

import { AppError } from "../errors";
import { asProjectId, type ProjectId } from "../ids";
import { DEFAULT_CORPUS_SLUG } from "../store/domain/default-corpus";
import { parseRetention } from "../store/domain/retention";

import { ACCESSIBLE_STATUSES } from "./access";
import { connectControlDb } from "./db";
import { eventLogFor } from "./event-log-for";
import { connection, project } from "./schema/app";
import { storeFor } from "./store-for";

// Reconcile sweep: tear down DO storage for soft-deleted projects. The
// D1 row is kept as a tombstone. ProjectStore and EventLogStore must
// wipe together or archived projects orphan activity history.
export async function reconcileProjects(env: Env): Promise<number> {
  const db = connectControlDb(env.DB);
  const deleted = await db
    .select({ id: project.id })
    .from(project)
    .where(eq(project.status, "deleted"));
  for (const p of deleted) {
    const projectId = asProjectId(p.id);
    await storeFor(env, projectId).purge();
    await eventLogFor(env, projectId).purge();
  }
  return deleted.length;
}

// Reconcile sweep: reap each live project's records past its retention
// window. Control plane owns policy; the per-Project DO owns deletion.
export async function reconcileRetention(env: Env): Promise<number> {
  const db = connectControlDb(env.DB);
  const rows = await db
    .select({ id: project.id, policy: project.policy })
    .from(project)
    .where(inArray(project.status, ACCESSIBLE_STATUSES));
  let sweptProjects = 0;
  for (const p of rows) {
    const retention = parseRetention(p.policy);
    if (
      retention.documentVersionDays === undefined &&
      retention.changeEventDays === undefined &&
      retention.blobDays === undefined
    ) {
      continue;
    }
    await storeFor(env, asProjectId(p.id)).reapExpired(retention);
    sweptProjects += 1;
  }
  return sweptProjects;
}

// "default-bound": only projects that still have a Connection bound to the
// default corpus. That binding is refused before the request reaches the
// project's store, so the agent using it cannot trigger the layout that
// would re-point it; this scope is the repair, and it selects nothing once
// every such Connection has been re-pointed. "all": every live project.
export type DriveLayoutScope = "all" | "default-bound";

export type DriveLayoutRunner = (projectId: ProjectId) => Promise<void>;

const UNCLASSIFIED_ERROR_KIND = "internal";

// Reconcile sweep: lay each selected project out as drives without waiting
// for someone to open it. One project failing does not stop the others.
export async function reconcileDriveLayout(
  env: Env,
  scope: DriveLayoutScope,
  layOut: DriveLayoutRunner = (projectId) =>
    storeFor(env, projectId).layOutAsDrivesIfNeeded(),
): Promise<Readonly<{ laidOut: number; failed: number }>> {
  const db = connectControlDb(env.DB);
  const live = inArray(project.status, ACCESSIBLE_STATUSES);
  const rows =
    scope === "all"
      ? await db.select({ id: project.id }).from(project).where(live)
      : await db
          .selectDistinct({ id: project.id })
          .from(project)
          .innerJoin(connection, eq(connection.projectId, project.id))
          .where(and(live, eq(connection.collectionSlug, DEFAULT_CORPUS_SLUG)));
  let laidOut = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await layOut(asProjectId(row.id));
      laidOut += 1;
    } catch (error) {
      failed += 1;
      console.error(
        "[scheduled] drive layout",
        error instanceof AppError ? error.kind : UNCLASSIFIED_ERROR_KIND,
      );
    }
  }
  return { laidOut, failed };
}
