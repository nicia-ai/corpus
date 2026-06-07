import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { connectControlDb } from "@/control/db";
import { entitlementsOf } from "@/control/entitlements";
import { DEFAULT_PROJECT_SLUG } from "@/control/org-lifecycle";
import {
  createProject as createProjectRow,
  deleteProject,
  projectSlug,
  renameProject as renameProjectRow,
} from "@/control/project-admin";
import type { ProjectRef } from "@/control/refs";
import { ForbiddenError, UnauthorizedError } from "@/errors";
import type { ProjectId } from "@/ids";
import { projectMiddleware } from "@/lib/middleware";
import { assertServerContext as srv } from "@/lib/server-context";

// Every project server fn acts on the URL-named project resolved by
// `projectMiddleware` (the membership-scoped `ProjectRef`) — never on
// client-supplied ids. Org/project mutation is owner-only, mirroring
// team management.
function actingRef(context: unknown): ProjectRef {
  const ref = srv(context).project;
  if (ref === undefined) throw new UnauthorizedError("No project");
  return ref;
}

function requireOwner(ref: ProjectRef): void {
  if (ref.role !== "owner") {
    throw new ForbiddenError("Only an organization owner can manage projects");
  }
}

// Soft-archive a project: the existing `deleteProject` (status →
// `deleted` + epoch bump) revokes access near-immediately; the DO
// teardown is the reconcile sweep's job. The org's `default` project is
// refused — it is the landing target the resolver falls back to, so
// archiving it would strand the org with no reachable project.
export type ArchiveResult = Readonly<
  { ok: true } | { ok: false; reason: "is_default" }
>;

export const createProject = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(z.object({ name: z.string().min(1) }))
  .handler(async ({ data, context }): Promise<{ projectId: ProjectId }> => {
    const c = srv(context);
    const ref = actingRef(context);
    requireOwner(ref);
    await entitlementsOf(c).assertWithinQuota({
      action: "project_create",
      userId: ref.userId,
      organizationId: ref.organizationId,
      projectId: ref.projectId,
      amount: 1,
    });
    const db = connectControlDb(c.env.DB);
    const projectId = await createProjectRow(db, ref.organizationId, data.name);
    return { projectId };
  });

export const renameProject = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(z.object({ name: z.string().min(1) }))
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const c = srv(context);
    const ref = actingRef(context);
    requireOwner(ref);
    await renameProjectRow(
      connectControlDb(c.env.DB),
      ref.projectId,
      data.name,
    );
    return { ok: true };
  });

export const archiveProject = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .handler(async ({ context }): Promise<ArchiveResult> => {
    const c = srv(context);
    const ref = actingRef(context);
    requireOwner(ref);
    const db = connectControlDb(c.env.DB);
    if ((await projectSlug(db, ref.projectId)) === DEFAULT_PROJECT_SLUG) {
      return { ok: false, reason: "is_default" };
    }
    await deleteProject(db, ref.projectId);
    return { ok: true };
  });
