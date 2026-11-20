import { createServerFn } from "@tanstack/react-start";
import { and, count, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";

import { connectControlDb, type ControlDb } from "@/control/db";
import { parseStoredStats, refreshProjectStats } from "@/control/project-stats";
import {
  account,
  adminAudit,
  member,
  organization,
  project,
  projectStats,
  user,
} from "@/control/schema";
import { storeFor } from "@/control/store-for";
import { ForbiddenError, UnauthorizedError, ValidationError } from "@/errors";
import { asProjectId } from "@/ids";
import {
  assertServerContext as srv,
  type ServerRequestContext,
} from "@/lib/server-context";
import type { ProjectStats } from "@/store/domain/project-stats";

// — Platform-admin gate ———————————————————————————————————————————
// Product-wide visibility, NOT org ownership. The gate is the platform
// role (`user.role === "admin"`, Better Auth admin plugin), bootstrapped
// for the first admin by ADMIN_EMAILS at signup (see auth.server.ts). An org
// "owner" (`member.role`, see control/access.ts) spans a single org's
// projects and never reaches here. Every admin server fn calls this
// first — hiding UI is not a gate.
export type AdminContext = Readonly<{
  id: string;
  email: string;
  name: string;
}>;

// Reads the request-scoped session (resolved once by sessionRequestMiddleware)
// rather than re-resolving it — every admin server fn would otherwise pay a
// second getSession per call.
export function requireSiteAdmin(c: ServerRequestContext): AdminContext {
  const u = c.authSession?.user;
  if (u === undefined) {
    throw new UnauthorizedError("Sign in required.");
  }
  if (u.role !== "admin") {
    throw new ForbiddenError("Platform admin access required.");
  }
  return { id: u.id, email: u.email ?? "", name: u.name ?? "" };
}

// Layout guard: returns the admin identity, throws Forbidden/Unauthorized
// otherwise. The /admin route loader catches and redirects non-admins.
export const adminGuard = createServerFn({ method: "GET" }).handler(
  ({ context }): AdminContext => requireSiteAdmin(srv(context)),
);

export type AdminUserRow = Readonly<{
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  // Platform role: "admin" | "user" | null. Distinct from org membership.
  role: string | null;
  banned: boolean;
  organizations: number;
  createdAt: number;
}>;

async function usersPage(
  db: ControlDb,
  limit: number,
  offset: number,
): Promise<AdminUserRow[]> {
  const rows = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      role: user.role,
      banned: user.banned,
      createdAt: user.createdAt,
      organizations: count(member.id),
    })
    .from(user)
    .leftJoin(member, eq(member.userId, user.id))
    .groupBy(user.id)
    .orderBy(desc(user.createdAt))
    .limit(limit)
    .offset(offset);
  return rows.map((r) => ({
    ...r,
    banned: r.banned ?? false,
    createdAt: r.createdAt.getTime(),
  }));
}

export type AdminOverview = Readonly<{
  users: number;
  admins: number;
  organizations: number;
  projects: number;
  // Better Auth `account.providerId` per row: "credential" | "google" | …
  signupsByMethod: Readonly<Record<string, number>>;
}>;

export const adminOverview = createServerFn({ method: "GET" }).handler(
  async ({ context }): Promise<AdminOverview> => {
    const c = srv(context);
    requireSiteAdmin(c);
    const db = connectControlDb(c.env.DB);
    const [users, admins, orgs, projects, methods] = await Promise.all([
      db.select({ n: count() }).from(user),
      db.select({ n: count() }).from(user).where(eq(user.role, "admin")),
      db.select({ n: count() }).from(organization),
      db
        .select({ n: count() })
        .from(project)
        .where(ne(project.status, "deleted")),
      db
        .select({ provider: account.providerId, n: count() })
        .from(account)
        .groupBy(account.providerId),
    ]);
    return {
      users: users[0]?.n ?? 0,
      admins: admins[0]?.n ?? 0,
      organizations: orgs[0]?.n ?? 0,
      projects: projects[0]?.n ?? 0,
      signupsByMethod: Object.fromEntries(
        methods.map((m) => [m.provider, m.n]),
      ),
    };
  },
);

export const adminListUsers = createServerFn({ method: "GET" }).handler(
  async ({ context }): Promise<AdminUserRow[]> => {
    const c = srv(context);
    requireSiteAdmin(c);
    return usersPage(connectControlDb(c.env.DB), 200, 0);
  },
);

export type AdminProjectRow = Readonly<{
  id: string;
  name: string;
  slug: string;
  status: string;
  organizationId: string;
  organizationName: string;
  createdAt: number;
  documents: number;
  corpora: number;
  versions: number;
  markdownBytes: number;
}>;

export type AdminProjects = Readonly<{
  projects: AdminProjectRow[];
  // Non-null when more projects exist than we loaded usage for — each row
  // is one ProjectStore DO call, so we cap and surface the truncation
  // rather than silently fan out unbounded.
  truncatedAt: number | null;
}>;

export const adminListProjects = createServerFn({ method: "GET" }).handler(
  async ({ context }): Promise<AdminProjects> => {
    const c = srv(context);
    requireSiteAdmin(c);
    const db = connectControlDb(c.env.DB);
    const CAP = 50;
    const rows = await db
      .select({
        id: project.id,
        name: project.name,
        slug: project.slug,
        status: project.status,
        organizationId: project.organizationId,
        organizationName: organization.name,
        createdAt: project.createdAt,
      })
      .from(project)
      .leftJoin(organization, eq(organization.id, project.organizationId))
      .where(ne(project.status, "deleted"))
      .orderBy(desc(project.createdAt))
      .limit(CAP + 1);
    const truncatedAt = rows.length > CAP ? CAP : null;
    const projects = await Promise.all(
      rows.slice(0, CAP).map(async (p): Promise<AdminProjectRow> => {
        // Per-project content/storage from the ProjectStore DO. Broken /
        // not-yet-initialized stores resolve to zeros rather than failing
        // the whole page.
        const usage = await storeFor(c.env, asProjectId(p.id))
          .usageSnapshot()
          .catch(() => ({
            activeDocuments: 0,
            corpora: 0,
            documentVersions: 0,
            storedMarkdownBytes: 0,
          }));
        return {
          id: p.id,
          name: p.name,
          slug: p.slug,
          status: p.status,
          organizationId: p.organizationId,
          organizationName: p.organizationName ?? "—",
          createdAt: p.createdAt.getTime(),
          documents: usage.activeDocuments,
          corpora: usage.corpora,
          versions: usage.documentVersions,
          markdownBytes: usage.storedMarkdownBytes,
        };
      }),
    );
    return { projects, truncatedAt };
  },
);

// — Structural project stats ——————————————————————————————————————
// Snapshots are computed in each project's DO (counts only) and stored in
// D1 by the daily cron; this surface reads them (one D1 query, no DO
// fan-out) and can recompute a single project on demand.

export const ADMIN_ACTION_REFRESH_PROJECT_STATS = "project.stats_refresh";
const PROJECT_STATS_LIST_CAP = 200;

export type AdminProjectStatsRow = Readonly<{
  projectId: string;
  name: string;
  organizationName: string;
  status: string;
  // Last successful computation; null if none has succeeded yet.
  computedAt: number | null;
  attemptedAt: number | null;
  errorKind: string | null;
  // Null when never computed, or stored under an older schema version.
  stats: ProjectStats | null;
}>;

export const adminListProjectStats = createServerFn({
  method: "GET",
}).handler(async ({ context }): Promise<AdminProjectStatsRow[]> => {
  const c = srv(context);
  requireSiteAdmin(c);
  const rows = await connectControlDb(c.env.DB)
    .select({
      projectId: project.id,
      name: project.name,
      organizationName: organization.name,
      status: project.status,
      schemaVersion: projectStats.schemaVersion,
      statsJson: projectStats.statsJson,
      computedAt: projectStats.computedAt,
      attemptedAt: projectStats.attemptedAt,
      errorKind: projectStats.errorKind,
    })
    .from(project)
    .leftJoin(organization, eq(organization.id, project.organizationId))
    .leftJoin(projectStats, eq(projectStats.projectId, project.id))
    .where(ne(project.status, "deleted"))
    .orderBy(desc(project.createdAt))
    .limit(PROJECT_STATS_LIST_CAP);
  return rows.map((r) => ({
    projectId: r.projectId,
    name: r.name,
    organizationName: r.organizationName ?? "—",
    status: r.status,
    computedAt: r.computedAt?.getTime() ?? null,
    attemptedAt: r.attemptedAt?.getTime() ?? null,
    errorKind: r.errorKind,
    stats:
      r.schemaVersion === null
        ? null
        : (parseStoredStats({
            schemaVersion: r.schemaVersion,
            statsJson: r.statsJson,
          }) ?? null),
  }));
});

export type AdminRefreshResult = Readonly<
  { ok: true } | { ok: false; errorKind: string }
>;

// Gate + recompute + audit, separate from the server-fn wrapper so the
// gate and the audit row are testable without the TanStack runtime.
export async function refreshProjectStatsAsAdmin(
  c: ServerRequestContext,
  projectId: string,
): Promise<AdminRefreshResult> {
  const admin = requireSiteAdmin(c);
  const db = connectControlDb(c.env.DB);
  const [target] = await db
    .select({ id: project.id })
    .from(project)
    .where(and(eq(project.id, projectId), ne(project.status, "deleted")));
  if (target === undefined) throw new ValidationError("Unknown project.");
  const outcome = await refreshProjectStats(c.env, asProjectId(target.id));
  await db.insert(adminAudit).values({
    actorUserId: admin.id,
    action: ADMIN_ACTION_REFRESH_PROJECT_STATS,
    targetType: "project",
    targetId: target.id,
    metadata: JSON.stringify({
      ok: outcome.ok,
      ...(outcome.ok ? {} : { errorKind: outcome.errorKind }),
    }),
  });
  return outcome.ok
    ? { ok: true }
    : { ok: false, errorKind: outcome.errorKind };
}

export const adminRefreshProjectStats = createServerFn({ method: "POST" })
  .validator(z.object({ projectId: z.string().min(1) }))
  .handler(({ data, context }): Promise<AdminRefreshResult> =>
    refreshProjectStatsAsAdmin(srv(context), data.projectId),
  );
