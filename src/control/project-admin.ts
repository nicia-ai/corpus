import { and, count, eq } from "drizzle-orm";

import { asProjectId, type OrganizationId, type ProjectId } from "../ids";

import { bumpAuthEpoch } from "./access";
import type { ControlDb } from "./db";
import { DEFAULT_PROJECT_SLUG, provenanceSlug } from "./org-lifecycle";
import { project } from "./schema/app";
import { member, organization } from "./schema/better-auth";

export async function createProject(
  db: ControlDb,
  organizationId: OrganizationId,
  name: string,
): Promise<ProjectId> {
  const id = crypto.randomUUID();
  await db
    .insert(project)
    .values({ id, organizationId, slug: provenanceSlug(name), name });
  return asProjectId(id);
}

// Rename = head metadata only. `project.name` is the human label; slug
// is identity and stays fixed.
export async function renameProject(
  db: ControlDb,
  projectId: ProjectId,
  name: string,
): Promise<void> {
  await db.update(project).set({ name }).where(eq(project.id, projectId));
}

// Soft-delete: status flips + epoch bump → resolve denies immediately.
export async function deleteProject(
  db: ControlDb,
  projectId: ProjectId,
): Promise<void> {
  await db
    .update(project)
    .set({ status: "deleted" })
    .where(eq(project.id, projectId));
  await bumpAuthEpoch(db, projectId);
}

export async function defaultProjectForOrgSlug(
  db: ControlDb,
  orgSlug: string,
): Promise<ProjectId | undefined> {
  const [row] = await db
    .select({ id: project.id })
    .from(project)
    .innerJoin(organization, eq(organization.id, project.organizationId))
    .where(
      and(
        eq(organization.slug, orgSlug),
        eq(project.slug, DEFAULT_PROJECT_SLUG),
      ),
    )
    .limit(1);
  return row === undefined ? undefined : asProjectId(row.id);
}

// The org + project slugs for bundle provenance.
export async function projectSlugs(
  db: ControlDb,
  ref: Readonly<{ organizationId: OrganizationId; projectId: ProjectId }>,
): Promise<{ organization: string; project: string }> {
  const [org] = await db
    .select({ slug: organization.slug })
    .from(organization)
    .where(eq(organization.id, ref.organizationId));
  const [proj] = await db
    .select({ slug: project.slug })
    .from(project)
    .where(eq(project.id, ref.projectId));
  return {
    organization: org?.slug ?? "",
    project: proj?.slug ?? "",
  };
}

export async function projectSlug(
  db: ControlDb,
  projectId: ProjectId,
): Promise<string | undefined> {
  const [row] = await db
    .select({ slug: project.slug })
    .from(project)
    .where(eq(project.id, projectId));
  return row?.slug;
}

export async function membershipCount(
  db: ControlDb,
  organizationId: OrganizationId,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(member)
    .where(eq(member.organizationId, organizationId));
  return row?.n ?? 0;
}
