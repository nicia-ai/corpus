import { eq, inArray } from "drizzle-orm";

import { asProjectId } from "../ids";
import { parseRetention } from "../store/domain/retention";

import { ACCESSIBLE_STATUSES } from "./access";
import { connectControlDb } from "./db";
import { eventLogFor } from "./event-log-for";
import { project } from "./schema/app";
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
