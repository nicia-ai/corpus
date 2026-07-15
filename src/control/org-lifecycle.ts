import { eq, sql } from "drizzle-orm";

import { asProjectId, type OrganizationId } from "../ids";
import { slugify } from "../util";

import type { ControlDb } from "./db";
import { eventLogFor } from "./event-log-for";
import { project } from "./schema/app";
import { storeFor } from "./store-for";

// The default project slug materialized for every organization. The UI
// hides the project selector while a single project exists.
export const DEFAULT_PROJECT_SLUG = "default";

// The default project's display name. Deliberately NOT the org name —
// the switcher already shows the org adjacent to every project, so
// echoing it here just reads as a confusing duplicate ("Dev / Dev").
export const DEFAULT_PROJECT_NAME = "Default";

// A display/provenance-only slug for a new org or project: a readable
// stem plus a short random suffix so it can't collide under the
// `(organizationId, slug)` unique index (and the org slug is globally
// unique). Routing always keys on the id, never this slug.
const SLUG_SUFFIX_LEN = 6;
export function provenanceSlug(name: string): string {
  return `${slugify(name)}-${crypto.randomUUID().slice(0, SLUG_SUFFIX_LEN)}`;
}

// Better Auth owns organization + member + invitation; Nicia owns
// `project` (one ProjectStore DO per project — a concept Better Auth has
// no notion of). This module is the seam between the two, imported by
// BOTH the Better Auth `organizationHooks` (src/auth.server.ts) and
// `tenancy.ts`, so neither imports the other (no cycle).

// `afterCreateOrganization` hook: materialize the org's default project.
// One insert, genuinely idempotent under concurrent fire — the
// `(organizationId, slug)` unique index absorbs a double via
// `onConflictDoNothing` (no pre-SELECT race). The ProjectStore DO
// self-heals its schema lazily on first access (ProjectStore.ensureStore).
export async function materializeDefaultProject(
  db: ControlDb,
  organizationId: OrganizationId,
): Promise<void> {
  await db
    .insert(project)
    .values({
      organizationId,
      slug: DEFAULT_PROJECT_SLUG,
      name: DEFAULT_PROJECT_NAME,
    })
    .onConflictDoNothing({
      target: [project.organizationId, project.slug],
    });
}

// Destructive membership change (member removed / role changed): bump
// every org project's epoch so the in-isolate validation cache
// invalidates on the next request (immediate revoke, not after TTL).
// One UPDATE — the org has one project today, but this stays correct if
// multi-project lands.
export async function bumpOrgProjectsEpoch(
  db: ControlDb,
  organizationId: OrganizationId,
): Promise<void> {
  await db
    .update(project)
    .set({ authEpoch: sql`${project.authEpoch} + 1` })
    .where(eq(project.organizationId, organizationId));
}

// `beforeDeleteOrganization` hook: tear down the org's ProjectStore DO
// storage AND the paired per-Project EventLogStore DO before Better
// Auth deletes the organization row (which cascade-deletes the
// `project` rows, after which we'd have no ids to purge). Each project
// owns two DOs that must wipe together — leaving the EventLogStore
// behind orphans the entire activity / instrumentation history.
// Idempotent.
export async function purgeOrgProjects(
  env: Env,
  db: ControlDb,
  organizationId: OrganizationId,
): Promise<void> {
  const rows = await db
    .select({ id: project.id })
    .from(project)
    .where(eq(project.organizationId, organizationId));
  for (const r of rows) {
    const projectId = asProjectId(r.id);
    await storeFor(env, projectId).purge();
    await eventLogFor(env, projectId).purge();
  }
}
