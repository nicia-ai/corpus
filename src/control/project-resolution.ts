import { and, asc, eq, inArray, type SQL } from "drizzle-orm";

import {
  asOrganizationId,
  asProjectId,
  asUserId,
  type OrganizationId,
  type ProjectId,
  type UserId,
} from "../ids";

import {
  ACCESSIBLE_STATUSES,
  asRole,
  isAccessible,
  markProjectReady,
  type ProjectStatus,
} from "./access";
import type { ControlDb } from "./db";
import { DEFAULT_PROJECT_SLUG } from "./org-lifecycle";
import type { ProjectRef } from "./refs";
import { project } from "./schema/app";
import { member, organization } from "./schema/better-auth";

type CacheEntry = Readonly<{ ref: ProjectRef; epoch: number; exp: number }>;

// In-isolate validation cache: removes the session+member join from the
// hot path for TTL_MS. A cheap indexed auth_epoch read still runs per
// request so destructive events take effect within ~1 read, not the full
// TTL. Bounded so a long-lived isolate with rotating tokens can't leak.
const TTL_MS = 45_000;
const CACHE_MAX = 5_000;
const cache = new Map<string, CacheEntry>();

function cacheKey(headers: Headers): string {
  return headers.get("authorization") ?? headers.get("cookie") ?? "";
}

function cacheSet(key: string, entry: CacheEntry): void {
  if (cache.size >= CACHE_MAX) {
    const now = Date.now();
    for (const [k, v] of cache) if (v.exp <= now) cache.delete(k);
    if (cache.size >= CACHE_MAX) cache.clear();
  }
  cache.set(key, entry);
}

// The user's accessible default project, joined through their org
// membership. A membership to an org whose default project is deleted or
// broken must not count as existing.
export async function accessibleProject(
  db: ControlDb,
  userId: UserId,
): Promise<ProjectRef | undefined> {
  const [row] = await db
    .select({
      organizationId: member.organizationId,
      role: member.role,
      projectId: project.id,
      status: project.status,
    })
    .from(member)
    .innerJoin(
      project,
      and(
        eq(project.organizationId, member.organizationId),
        eq(project.slug, DEFAULT_PROJECT_SLUG),
        inArray(project.status, ACCESSIBLE_STATUSES),
      ),
    )
    .where(eq(member.userId, userId))
    .orderBy(asc(project.createdAt))
    .limit(1);
  if (row === undefined || !isAccessible(row.status)) return undefined;
  return {
    organizationId: asOrganizationId(row.organizationId),
    projectId: asProjectId(row.projectId),
    userId,
    role: asRole(row.role),
  };
}

async function liveState(
  db: ControlDb,
  projectId: ProjectId,
): Promise<{ epoch: number; status: ProjectStatus } | undefined> {
  const [row] = await db
    .select({ e: project.authEpoch, s: project.status })
    .from(project)
    .where(eq(project.id, projectId));
  if (row === undefined) return undefined;
  const status = row.s;
  return isAccessible(status) ? { epoch: row.e, status } : undefined;
}

async function resolveRef(
  db: ControlDb,
  getSession: () => Promise<{ user: { id: string } } | null>,
  headers: Headers,
  select: Readonly<{ match: SQL; orderBy?: SQL; cacheSuffix: string }>,
): Promise<ProjectRef | undefined> {
  const base = cacheKey(headers);
  const key = base === "" ? "" : `${base}${select.cacheSuffix}`;
  const hit = key === "" ? undefined : cache.get(key);
  if (hit !== undefined && hit.exp > Date.now()) {
    const [live, session] = await Promise.all([
      liveState(db, hit.ref.projectId),
      getSession(),
    ]);
    if (session === null) {
      cache.delete(key);
      return undefined;
    }
    if (live?.epoch === hit.epoch) return hit.ref;
    cache.delete(key);
  }

  const session = await getSession();
  if (session === null) return undefined;

  const base$ = db
    .select({
      organizationId: member.organizationId,
      role: member.role,
      projectId: project.id,
    })
    .from(member)
    .innerJoin(
      project,
      and(
        eq(project.organizationId, member.organizationId),
        select.match,
        inArray(project.status, ACCESSIBLE_STATUSES),
      ),
    )
    .where(eq(member.userId, session.user.id));
  const [m] = await (
    select.orderBy ? base$.orderBy(select.orderBy) : base$
  ).limit(1);
  if (m === undefined) return undefined;
  const projectId = asProjectId(m.projectId);

  const live = await liveState(db, projectId);
  if (live === undefined) return undefined;

  if (live.status === "initializing") {
    await markProjectReady(db, projectId);
  }

  const ref: ProjectRef = {
    organizationId: asOrganizationId(m.organizationId),
    projectId,
    userId: asUserId(session.user.id),
    role: asRole(m.role),
  };
  if (key !== "") {
    cacheSet(key, { ref, epoch: live.epoch, exp: Date.now() + TTL_MS });
  }
  return ref;
}

// The session's default project.
export function resolveProject(
  db: ControlDb,
  getSession: () => Promise<{ user: { id: string } } | null>,
  headers: Headers,
): Promise<ProjectRef | undefined> {
  return resolveRef(db, getSession, headers, {
    match: eq(project.slug, DEFAULT_PROJECT_SLUG),
    orderBy: asc(project.createdAt),
    cacheSuffix: "",
  });
}

// The URL-named project, scoped to the session's memberships.
export function resolveProjectById(
  db: ControlDb,
  getSession: () => Promise<{ user: { id: string } } | null>,
  headers: Headers,
  projectId: string,
): Promise<ProjectRef | undefined> {
  return resolveRef(db, getSession, headers, {
    match: eq(project.id, projectId),
    cacheSuffix: ` ${projectId}`,
  });
}

export async function listAccessibleProjects(
  db: ControlDb,
  userId: UserId,
): Promise<
  readonly Readonly<{
    organizationId: OrganizationId;
    projectId: ProjectId;
    name: string;
    slug: string;
  }>[]
> {
  const rows = await listAccessibleProjectsByOrg(db, userId);
  return rows.map((r) => ({
    organizationId: r.organizationId,
    projectId: r.projectId,
    name: r.name,
    slug: r.slug,
  }));
}

export async function listAccessibleProjectsByOrg(
  db: ControlDb,
  userId: UserId,
): Promise<
  readonly Readonly<{
    organizationId: OrganizationId;
    organizationName: string;
    projectId: ProjectId;
    name: string;
    slug: string;
  }>[]
> {
  const rows = await db
    .select({
      organizationId: member.organizationId,
      organizationName: organization.name,
      projectId: project.id,
      name: project.name,
      slug: project.slug,
    })
    .from(member)
    .innerJoin(
      project,
      and(
        eq(project.organizationId, member.organizationId),
        inArray(project.status, ACCESSIBLE_STATUSES),
      ),
    )
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, userId))
    .orderBy(asc(project.createdAt));
  return rows.map((r) => ({
    organizationId: asOrganizationId(r.organizationId),
    organizationName: r.organizationName,
    projectId: asProjectId(r.projectId),
    name: r.name,
    slug: r.slug,
  }));
}
