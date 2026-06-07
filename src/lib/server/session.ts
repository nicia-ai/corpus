import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";

import { getAuth } from "@/auth";
import type { Role } from "@/control/access";
import { countConnectionsByCollection } from "@/control/connections";
import { connectControlDb } from "@/control/db";
import { entitlementsOf } from "@/control/entitlements";
import { resolveServerEnv, type SidebarLink } from "@/control/env";
import { provenanceSlug } from "@/control/org-lifecycle";
import { defaultProjectForOrgSlug } from "@/control/project-admin";
import {
  accessibleProject,
  listAccessibleProjectsByOrg,
  resolveProject,
  resolveProjectById,
} from "@/control/project-resolution";
import { storeFor } from "@/control/store-for";
import { InternalError } from "@/errors";
import type { OrganizationId, ProjectId } from "@/ids";
import { authMiddleware } from "@/lib/middleware";
import {
  type ColMeta,
  colMetas,
  type CollectionMember,
  collectionMemberMetas,
} from "@/lib/server/collections";
import { type DocMeta, docMetas } from "@/lib/server/documents";
import { authedUserId } from "@/lib/server/shared";
import { assertServerContext as srv } from "@/lib/server-context";
import { compact } from "@/util";

// firstRun:false carries everything the dashboard renders in one
// round-trip: counts + the shared-document proof
// (documents / attachments) + recent collection list + the MCP
// endpoint + per-collection connection counts (the Home collections
// strip's "N agents" pill). Collections with zero Connections are
// absent from `connectionsByCollection`.
export type DashboardData = Readonly<{
  collections: ColMeta[];
  documents: DocMeta[];
  members: CollectionMember[];
  mcpUrl: string;
  connectionsByCollection: Readonly<Record<string, number>>;
}>;

// — Session / first-run ————————————————————————————————————————

export const getMcpUrl = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(({ context }): string => `${srv(context).env.BETTER_AUTH_URL}/mcp`);

// First-run org creation, driven through the Better Auth organization
// plugin so it owns organization + the creator's owner `member`; the
// plugin's `afterCreateOrganization` hook materializes the default
// `project`. Idempotent: a re-submitted form (the common double-submit)
// returns the user's existing project instead of orphaning a new org.
// Slug carries a short random suffix because the plugin enforces a
// global-unique org slug while our slug is display/provenance only
// (routing keys on project.id, never slug).
export const createOrganization = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      name: z.string().min(1),
      // First-run (the `/` form) leaves this unset and is idempotent on a
      // double-submit. The switcher's "+ New organization" sets it to
      // deliberately create a *second* org, bypassing that guard.
      allowAdditional: z.boolean().optional(),
    }),
  )
  .handler(async ({ data, context }): Promise<{ projectId: ProjectId }> => {
    const c = srv(context);
    const db = connectControlDb(c.env.DB);
    const userId = authedUserId(c);
    if (data.allowAdditional !== true) {
      const existing = await accessibleProject(db, userId);
      if (existing !== undefined) return { projectId: existing.projectId };
    }

    // Org creation materializes the org's default project (the
    // `afterCreateOrganization` hook) — this is OSS's project-create
    // transport edge. Gated after the idempotency check so a re-submit
    // is not charged quota. The org slug is globally unique (the random
    // suffix avoids collisions) and is the deterministic key back to the
    // just-materialized default project — independent of Better Auth's
    // create return shape.
    await entitlementsOf(c).assertWithinQuota({
      action: "project_create",
      userId,
      amount: 1,
    });
    const slug = provenanceSlug(data.name);
    await getAuth(c.env).api.createOrganization({
      body: { name: data.name, slug },
      headers: new Headers(getRequestHeaders()),
    });

    const projectId = await defaultProjectForOrgSlug(db, slug);
    if (projectId === undefined) {
      throw new InternalError(
        "organization created but default project did not materialize " +
          "(afterCreateOrganization hook in src/control/org-lifecycle.ts)",
      );
    }
    return { projectId };
  });

// The landing resolver: turns "where do I send a slug-less request?"
// into one of three answers. No middleware (it must not throw on an
// unauthenticated or project-less visitor) and resolves the project
// itself, exactly once. The `/` route and the bare-deep-link splat both
// call this to learn the canonical `/p/<projectId>` prefix to redirect to.
export const resolveLanding = createServerFn({ method: "GET" }).handler(
  async ({
    context,
  }): Promise<
    | { authed: false }
    | { authed: true; firstRun: true }
    | { authed: true; firstRun: false; projectId: ProjectId }
  > => {
    const c = srv(context);
    const userId = c.authSession?.user.id;
    if (userId === undefined) return { authed: false };
    const ref = await resolveProject(
      connectControlDb(c.env.DB),
      () => Promise.resolve({ user: { id: userId } }),
      new Headers(getRequestHeaders()),
    );
    if (ref === undefined) return { authed: true, firstRun: true };
    return { authed: true, firstRun: false, projectId: ref.projectId };
  },
);

// The switcher routes on `id` (globally unique, the URL key); `name` is
// the human label; `slug` is shown read-only on the settings page (not
// addressable — routing keys on `id`).
export type ProjectChoice = Readonly<{
  id: ProjectId;
  name: string;
  slug: string;
}>;
// Projects grouped by their owning org — the switcher's menu sections.
export type OrgGroup = Readonly<{
  id: OrganizationId;
  name: string;
  projects: readonly ProjectChoice[];
}>;
export type ProjectShell = Readonly<{
  current: Readonly<{
    orgId: OrganizationId;
    orgName: string;
    // The acting role in the *current* org — owner-only switcher actions
    // (New project, Manage) hide when this is "member".
    role: Role;
    project: ProjectChoice;
  }>;
  user: Readonly<{
    name?: string;
    email?: string;
  }>;
  orgs: readonly OrgGroup[];
  // Optional sidebar-footer links resolved from env (off by default), folded
  // into the shell so they ride the existing app-chrome round-trip — static
  // config, not project data. `support` is SUPPORT_URL/SUPPORT_EMAIL; `docs`
  // is DOCS_URL (the hosted deploy sets it to /docs; the OSS app ships no
  // docs site of its own, so self-hosters opt in).
  support: SidebarLink | null;
  docs: SidebarLink | null;
}>;

// The `/p/$projectId` layout guard + switcher feed in one round-trip.
// `ok:false` means the id is not a project this session may reach
// (signed out, not a member, broken/deleted) — the layout redirects to
// `/` (the resolver) rather than leaking existence. `projects` is every
// project the user can switch to (the switcher hides itself at < 2).
export const loadProjectShell = createServerFn({ method: "GET" })
  .validator(z.object({ projectId: z.string().min(1) }))
  .handler(
    async ({
      data,
      context,
    }): Promise<{ ok: false } | ({ ok: true } & ProjectShell)> => {
      const c = srv(context);
      const userId = c.authSession?.user.id;
      if (userId === undefined) return { ok: false };
      const db = connectControlDb(c.env.DB);
      const ref = await resolveProjectById(
        db,
        () => Promise.resolve({ user: { id: userId } }),
        new Headers(getRequestHeaders()),
        data.projectId,
      );
      if (ref === undefined) return { ok: false };
      const rows = await listAccessibleProjectsByOrg(db, ref.userId);
      // One pass over the (oldest-first) rows: group into orgs preserving
      // first-seen order, and capture the current project's display data
      // as it goes (no second scan).
      const byOrg = new Map<
        OrganizationId,
        { id: OrganizationId; name: string; projects: ProjectChoice[] }
      >();
      let current: ProjectShell["current"] | undefined;
      for (const r of rows) {
        const g = byOrg.get(r.organizationId) ?? {
          id: r.organizationId,
          name: r.organizationName,
          projects: [],
        };
        const choice: ProjectChoice = {
          id: r.projectId,
          name: r.name,
          slug: r.slug,
        };
        g.projects.push(choice);
        byOrg.set(r.organizationId, g);
        if (r.projectId === ref.projectId) {
          current = {
            orgId: ref.organizationId,
            orgName: r.organizationName,
            role: ref.role,
            project: choice,
          };
        }
      }
      // `ref` resolved through membership, so a matching accessible row —
      // and thus `current` — is expected. If it's somehow absent (the id is
      // unreachable for this session), treat it as a stale link per the
      // contract: ok:false → the layout redirects to `/`. Never fabricate a
      // shell from raw ids (an id is not a display name).
      if (current === undefined) return { ok: false };
      const cfg = resolveServerEnv(c.env);
      return {
        ok: true,
        current,
        user: compact({
          name: c.authSession?.user.name,
          email: c.authSession?.user.email,
        }),
        orgs: [...byOrg.values()],
        support: cfg.support ?? null,
        docs: cfg.docs ?? null,
      };
    },
  );

// One round-trip for the dashboard route: signals unauthenticated (loader
// redirects), first-run (no organization yet), or the full home payload.
// No middleware so it never throws on an unauthenticated
// visitor; it resolves the URL-named project itself, exactly once. The
// `/p/$projectId` layout already gated membership — an unresolvable id
// here only happens on a stale link, handled as "redirect to /".
export const loadDashboard = createServerFn({ method: "GET" })
  .validator(z.object({ projectId: z.string().min(1) }))
  .handler(
    async ({
      data,
      context,
    }): Promise<
      | { authed: false }
      | { authed: true; firstRun: true }
      | ({ authed: true; firstRun: false } & DashboardData)
    > => {
      const c = srv(context);
      const userId = c.authSession?.user.id;
      if (userId === undefined) return { authed: false };
      const headers = new Headers(getRequestHeaders());
      const ref = await resolveProjectById(
        connectControlDb(c.env.DB),
        () => Promise.resolve({ user: { id: userId } }),
        headers,
        data.projectId,
      );
      if (ref === undefined) return { authed: true, firstRun: true };
      const store = storeFor(c.env, ref.projectId);
      const db = connectControlDb(c.env.DB);
      const [cols, documents, members, connCounts] = await Promise.all([
        store.listCollections(),
        store.listDocuments(),
        store.listResolvedMembers(),
        countConnectionsByCollection(db, ref.projectId),
      ]);
      return {
        authed: true,
        firstRun: false,
        collections: colMetas(cols),
        documents: docMetas(documents),
        members: collectionMemberMetas(members),
        mcpUrl: `${c.env.BETTER_AUTH_URL}/mcp`,
        connectionsByCollection: Object.fromEntries(connCounts),
      };
    },
  );
