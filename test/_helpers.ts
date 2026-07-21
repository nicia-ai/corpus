import { env } from "cloudflare:test";
import { z } from "zod";

import { getAuth } from "../src/auth.server";
import { connectControlDb } from "../src/control/db";
import {
  DEFAULT_PROJECT_NAME,
  DEFAULT_PROJECT_SLUG,
} from "../src/control/org-lifecycle";
import { connection, project } from "../src/control/schema/app";
import { member, organization } from "../src/control/schema/better-auth";
import { storeFor } from "../src/control/store-for";
import type { EventLogStore } from "../src/event-log-store";
import {
  asConnectionId,
  asCollectionSlug,
  asOrganizationId,
  asProjectId,
  asUserId,
  type ConnectionId,
  type CollectionSlug,
  type OrganizationId,
  type ProjectId,
  type UserId,
} from "../src/ids";
import type { ProjectStore } from "../src/project-store";

// Branded fixture constructors — tests cross the same trust boundary as
// production callers, so they build ids the same way.
export {
  asCollectionSlug as colSlug,
  asDocumentSlug as docSlug,
} from "../src/ids";

// vitest-pool-workers isolates storage per test FILE (each file is its own
// Worker isolate with its own D1 + DO storage; verified — a row written in
// one file is invisible in another). Within a file the counter `n` alone
// guarantees unique emails / ids. The per-module salt is defense in depth:
// it keeps identifiers unique even if that isolation is ever weakened (e.g.
// a future pool option that shares storage), at no cost. NB the removed
// `isolatedStorage: false` in vite.config.ts never enabled sharing — the
// pool dropped that option and its schema silently strips it.
const SALT = Math.random().toString(36).slice(2, 8);
let n = 0;

export async function signUp(prefix = "u"): Promise<UserId> {
  n += 1;
  const res = await getAuth(env).api.signUpEmail({
    body: {
      email: `${prefix}-${SALT}-${String(n)}@example.com`,
      password: "correct-horse-battery-staple",
      name: `${prefix} ${String(n)}`,
    },
  });
  return asUserId(res.user.id);
}

const signUpResponseZ = z.object({ user: z.object({ id: z.string().min(1) }) });

// Sign up AND return a session cookie header, so a test can drive
// authenticated Better Auth server APIs (org plugin: createOrganization,
// createInvitation, acceptInvitation). emailAndPassword auto-signs-in on
// signup, so the response carries the session Set-Cookie.
export async function signUpSession(
  prefix = "u",
): Promise<Readonly<{ userId: UserId; email: string; headers: Headers }>> {
  n += 1;
  const email = `${prefix}-${SALT}-${String(n)}@example.com`;
  const res = await getAuth(env).api.signUpEmail({
    body: { email, password: "correct-horse-battery-staple", name: prefix },
    asResponse: true,
  });
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  // `res.json()` is `unknown`; parse rather than assert so a change to the
  // Better Auth signup response shape fails here with a readable message
  // instead of surfacing as an undefined userId deep in a later assertion.
  const body = signUpResponseZ.parse(await res.json());
  return {
    userId: asUserId(body.user.id),
    email,
    headers: new Headers({ cookie }),
  };
}

// Directly seed organization + owner member + default project, mirroring
// what `auth.api.createOrganization` + the `afterCreateOrganization`
// hook do. For control-plane unit tests (resolveProject / epoch /
// listAccessible) that exercise tenancy resolution, not the plugin's
// org-creation HTTP flow (team.test.ts covers that end-to-end).
export async function createOrg(
  userId: UserId,
  name = "Acme Ops",
): Promise<Readonly<{ organizationId: OrganizationId; projectId: ProjectId }>> {
  n += 1;
  const db = connectControlDb(env.DB);
  const organizationId = crypto.randomUUID();
  const now = new Date();
  await db.insert(organization).values({
    id: organizationId,
    name,
    slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${SALT}-${String(n)}`,
    createdAt: now,
  });
  await db.insert(member).values({
    id: crypto.randomUUID(),
    organizationId,
    userId,
    role: "owner",
    createdAt: now,
  });
  // status defaults to "initializing" — exactly what
  // materializeDefaultProject (the afterCreateOrganization hook) inserts;
  // resolveProject graduates it to "ready" on first resolve.
  const [proj] = await db
    .insert(project)
    .values({
      organizationId,
      slug: DEFAULT_PROJECT_SLUG,
      name: DEFAULT_PROJECT_NAME,
    })
    .returning({ id: project.id });
  return {
    organizationId: asOrganizationId(organizationId),
    projectId: asProjectId(proj?.id ?? ""),
  };
}

// Seed an additional project (non-default slug) into an existing org —
// the multi-project shape `auth.api` has no hook for yet. For tests that
// exercise slug-addressed resolution (resolveProjectBySlug) where the
// org's default project is not the target.
export async function addProject(
  organizationId: OrganizationId,
  slug: string,
  name = slug,
): Promise<ProjectId> {
  const db = connectControlDb(env.DB);
  const [proj] = await db
    .insert(project)
    .values({ organizationId, slug, name })
    .returning({ id: project.id });
  return asProjectId(proj?.id ?? "");
}

// Seed a Connection (Project + one Collection) — the agent-facing
// credential unit (v4). Tests that mint keys / drive OAuth bind to a
// Connection, never a Project. Mirrors createOrg's direct-insert style.
export async function createConnection(
  args: Readonly<{
    organizationId: OrganizationId;
    projectId: ProjectId;
    collectionSlug?: string;
    name?: string;
    isDefaultForCollection?: boolean;
  }>,
): Promise<
  Readonly<{ connectionId: ConnectionId; collectionSlug: CollectionSlug }>
> {
  n += 1;
  const db = connectControlDb(env.DB);
  const collectionSlug = args.collectionSlug ?? `col-${SALT}-${String(n)}`;
  const [row] = await db
    .insert(connection)
    .values({
      organizationId: args.organizationId,
      projectId: args.projectId,
      collectionSlug,
      name: args.name ?? collectionSlug,
      isDefaultForCollection: args.isDefaultForCollection ?? false,
    })
    .returning({ id: connection.id });
  return {
    connectionId: asConnectionId(row?.id ?? ""),
    collectionSlug: asCollectionSlug(collectionSlug),
  };
}

// Create the bound Collection in the per-Project DO so the respondMcp
// preflight (collectionMembers) finds it. Returns the slug for chaining.
// Empty members; tests that need docs in the Collection attach them via
// the DO's normal createDocument/attach flow.
export async function createCollectionFor(
  projectId: ProjectId,
  collectionSlug: CollectionSlug,
  name: string = collectionSlug,
): Promise<CollectionSlug> {
  await storeFor(env, projectId).createCollection({
    slug: collectionSlug,
    name,
    changedBy: "test-helper",
  });
  return collectionSlug;
}

export function freshStore(prefix = "proj"): DurableObjectStub<ProjectStore> {
  n += 1;
  return env.PROJECT_STORE.get(
    env.PROJECT_STORE.idFromName(`${prefix}-${SALT}-${String(n)}`),
  );
}

// Sibling of `freshStore`: addresses the per-Project EventLogStore DO
// via the same SALT/counter discipline so two helpers in the same test
// can target the same project's storage if they share the prefix+id.
export function freshEventLog(
  prefix = "elog",
): DurableObjectStub<EventLogStore> {
  n += 1;
  return env.EVENT_LOG_STORE.get(
    env.EVENT_LOG_STORE.idFromName(`${prefix}-${SALT}-${String(n)}`),
  );
}

// A Project's ProjectStore + its paired EventLogStore (same name, same
// projectId), so a wedge integration test can drive saves through the
// store and observe events on the log. The projectId IS the shared
// idFromName argument; ProjectStore.ctx.id.name returns it and uses
// it to address the EventLogStore via `eventLogFor`, so a write here
// lands in the log of the EventLogStore returned here.
export function freshProject(prefix = "proj"): Readonly<{
  store: DurableObjectStub<ProjectStore>;
  log: DurableObjectStub<EventLogStore>;
  projectId: string;
}> {
  n += 1;
  const projectId = `${prefix}-${SALT}-${String(n)}`;
  return {
    store: env.PROJECT_STORE.get(env.PROJECT_STORE.idFromName(projectId)),
    log: env.EVENT_LOG_STORE.get(env.EVENT_LOG_STORE.idFromName(projectId)),
    projectId,
  };
}
