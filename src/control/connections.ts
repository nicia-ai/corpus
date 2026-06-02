import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";

import {
  asConnectionId,
  asCollectionSlug,
  asOrganizationId,
  asProjectId,
  type ConnectionId,
  type CollectionSlug,
  type OrganizationId,
  type ProjectId,
  type UserId,
} from "../ids";

import { ACCESSIBLE_STATUSES, asRole, type Role } from "./access";
import type { ControlDb } from "./db";
import { apiKey, connection, project } from "./schema/app";
import { member, oauthConsent, oauthRefreshToken } from "./schema/better-auth";

// A Connection is an org/project asset — administered by org `owner`s,
// used by any member (the resolve-time `member` join in tenancy.ts).
// Connections are NOT owned by the creator, so they have no user FK;
// reachability is always the live membership join.

export type ConnectionSummary = Readonly<{
  connectionId: ConnectionId;
  organizationId: OrganizationId;
  projectId: ProjectId;
  collectionSlug: CollectionSlug;
  name: string;
  isDefaultForCollection: boolean;
  projectName: string;
  role: Role;
}>;

// Every Connection the user can reach through any org membership — the
// candidate set a credential (API key / OAuth grant) may bind to. The
// membership join is the security boundary (any role may bind; the
// resolve path re-checks membership per request).
export async function listConnectionsForUser(
  db: ControlDb,
  userId: UserId,
): Promise<readonly ConnectionSummary[]> {
  const rows = await db
    .select({
      connectionId: connection.id,
      organizationId: connection.organizationId,
      projectId: connection.projectId,
      collectionSlug: connection.collectionSlug,
      name: connection.name,
      isDefaultForCollection: connection.isDefaultForCollection,
      projectName: project.name,
      role: member.role,
    })
    .from(connection)
    .innerJoin(
      member,
      and(
        eq(member.organizationId, connection.organizationId),
        eq(member.userId, userId),
      ),
    )
    .innerJoin(
      project,
      and(
        eq(project.id, connection.projectId),
        inArray(project.status, ACCESSIBLE_STATUSES),
      ),
    )
    .orderBy(asc(connection.createdAt));
  return rows.map((r) => ({
    connectionId: asConnectionId(r.connectionId),
    organizationId: asOrganizationId(r.organizationId),
    projectId: asProjectId(r.projectId),
    collectionSlug: asCollectionSlug(r.collectionSlug),
    name: r.name,
    isDefaultForCollection: r.isDefaultForCollection,
    projectName: r.projectName,
    role: asRole(r.role),
  }));
}

// Every Connection the user ADMINISTERS (org `owner` role) — the
// candidate set for `/connect/select`. Reads (including via existing
// credentials) stay role-agnostic in `resolveApiKey`/`resolveConnection`;
// administration (create/rename/delete + binding a new credential)
// requires owner. Reuses `listConnectionsForUser` and filters in JS by
// the same `asRole` mapping `tenancy.ts` uses — one source of truth for
// "owner-in-comma-list."
export async function listAdministeredConnections(
  db: ControlDb,
  userId: UserId,
): Promise<readonly ConnectionSummary[]> {
  const all = await listConnectionsForUser(db, userId);
  return all.filter((c) => c.role === "owner");
}

// How many Connections live under each Collection in a Project. Powers
// the "N agents" pill on the Home collections strip — one round-trip
// per dashboard render, scoped by projectId (already membership-
// checked at the caller). Collections with zero Connections are absent
// from the map.
export async function countConnectionsByCollection(
  db: ControlDb,
  projectId: ProjectId,
): Promise<ReadonlyMap<CollectionSlug, number>> {
  const rows = await db
    .select({
      collectionSlug: connection.collectionSlug,
      n: count(connection.id),
    })
    .from(connection)
    .where(eq(connection.projectId, projectId))
    .groupBy(connection.collectionSlug);
  return new Map(rows.map((r) => [asCollectionSlug(r.collectionSlug), r.n]));
}

// Reuse-or-create the canonical Connection for (projectId, collectionSlug).
// One round-trip, race-safe: a concurrent first-click cannot tear,
// because the partial unique index `WHERE isDefaultForCollection` covers
// exactly the canonical row and `ON CONFLICT … DO UPDATE … RETURNING`
// returns the winning row's id either way. `name` is touched (not
// keyed): a later Collection rename never spawns a second canonical row.
// Advanced (`isDefaultForCollection: false`) Connections are unconstrained
// by the index and use a plain insert at the call site.
export async function createCanonicalConnection(
  db: ControlDb,
  args: Readonly<{
    organizationId: OrganizationId;
    projectId: ProjectId;
    collectionSlug: CollectionSlug;
    name?: string;
  }>,
): Promise<ConnectionId> {
  const name = args.name ?? args.collectionSlug;
  const [row] = await db
    .insert(connection)
    .values({
      organizationId: args.organizationId,
      projectId: args.projectId,
      collectionSlug: args.collectionSlug,
      name,
      isDefaultForCollection: true,
    })
    .onConflictDoUpdate({
      // Match the partial unique index's predicate EXACTLY — SQLite
      // requires that for ON CONFLICT to pick a partial index. The
      // schema's `.where(sql\`${t.isDefaultForCollection}\`)` emits a
      // FULLY-QUALIFIED bare boolean (`"connection"."is_default_for_collection"`)
      // into the migration; the conflict clause must match qualifier
      // and all. An unqualified `"is_default_for_collection"` here
      // silently misses the index and SQLite rejects the insert
      // with "no unique or exclusion constraint matching" — the bug
      // the user's "Connect this collection" button surfaced.
      // `eq(col, true)` won't work either: it emits `col = ?` which
      // is a different predicate from the bare boolean. Raw SQL with
      // the qualified column is the only path.
      target: [connection.projectId, connection.collectionSlug],
      targetWhere: sql`"connection"."is_default_for_collection"`,
      set: { name },
    })
    .returning({ id: connection.id });
  if (row === undefined) {
    throw new Error("createCanonicalConnection: no row returned");
  }
  return asConnectionId(row.id);
}

// Read-only canonical Connection lookup (the upsert path is
// `upsertCanonicalConnection` above).
export async function findCanonicalConnectionByCollection(
  db: ControlDb,
  projectId: ProjectId,
  collectionSlug: CollectionSlug,
): Promise<ConnectionId | undefined> {
  const [row] = await db
    .select({ id: connection.id })
    .from(connection)
    .where(
      and(
        eq(connection.projectId, projectId),
        eq(connection.collectionSlug, collectionSlug),
        eq(connection.isDefaultForCollection, true),
      ),
    )
    .limit(1);
  return row === undefined ? undefined : asConnectionId(row.id);
}

// SELECT-then-INSERT-or-UPDATE variant of the canonical Connection
// upsert. The partial-index `ON CONFLICT` path in
// `createCanonicalConnection` above failed in D1 in practice across
// multiple WHERE-predicate forms (qualified vs unqualified, raw SQL
// vs `eq(col, true)`) — D1's SQLite rejects an ON CONFLICT clause
// whose target predicate the optimizer can't byte-match against the
// stored partial index. This path avoids the partial-index ON CONFLICT
// entirely and relies on a plain WHERE-equality SELECT + id-keyed
// INSERT/UPDATE. The at-most-one-default-per-(project, context)
// invariant is still enforced server-side by the partial unique index;
// a concurrent insert from another caller would throw, which the
// caller can retry to land on the existing-row branch. In practice
// "Connect this collection" is a user-initiated single click per session
// and a concurrent race is theoretical.
export async function upsertCanonicalConnection(
  db: ControlDb,
  args: Readonly<{
    organizationId: OrganizationId;
    projectId: ProjectId;
    collectionSlug: CollectionSlug;
    name?: string;
  }>,
): Promise<ConnectionId> {
  const name = args.name ?? args.collectionSlug;
  try {
    const [existing] = await db
      .select({ id: connection.id, name: connection.name })
      .from(connection)
      .where(
        and(
          eq(connection.projectId, args.projectId),
          eq(connection.collectionSlug, args.collectionSlug),
          eq(connection.isDefaultForCollection, true),
        ),
      )
      .limit(1);
    if (existing !== undefined) {
      if (existing.name !== name) {
        await db
          .update(connection)
          .set({ name })
          .where(eq(connection.id, existing.id));
      }
      return asConnectionId(existing.id);
    }
    const [row] = await db
      .insert(connection)
      .values({
        organizationId: args.organizationId,
        projectId: args.projectId,
        collectionSlug: args.collectionSlug,
        name,
        isDefaultForCollection: true,
      })
      .returning({ id: connection.id });
    if (row === undefined) {
      throw new Error("upsertCanonicalConnection: no row returned");
    }
    return asConnectionId(row.id);
  } catch (err) {
    // Drizzle wraps D1 errors as `Failed query: <sql>` and hides the
    // underlying SQLite message on `.cause`. Surface both so a stale
    // local D1 ("no such table: connection") doesn't look identical to
    // an ON CONFLICT predicate mismatch ("no unique or exclusion
    // constraint matching") in the UI's red error band.
    const cause =
      err instanceof Error && err.cause instanceof Error
        ? err.cause.message
        : err instanceof Error
          ? err.message
          : String(err);
    throw new Error(`upsertCanonicalConnection failed: ${cause}`, {
      cause: err,
    });
  }
}

// Rename — a single D1 row write, scoped by (connectionId, projectId).
// The dual key is the security boundary: an owner of project A who knows
// a connectionId from project B must not be able to mutate B's row by
// passing its id alone. A wrong-project call is a silent no-op (0 rows
// match) — same shape as a wrong-id call, no oracle.
export async function renameConnection(
  db: ControlDb,
  args: Readonly<{
    connectionId: ConnectionId;
    projectId: ProjectId;
    name: string;
  }>,
): Promise<void> {
  await db
    .update(connection)
    .set({ name: args.name })
    .where(
      and(
        eq(connection.id, args.connectionId),
        eq(connection.projectId, args.projectId),
      ),
    );
}

// Delete — ordered, idempotent, scoped. Re-runnable: every step is safe
// if the row is already absent / already revoked. The leading SELECT is
// the cross-project guard: the cascade (refresh-token revoke + consent
// delete) is keyed by `reference_id` only because those tables have no
// project column, so we must prove (id, projectId) match before touching
// any of them. Steps:
//   (0) SELECT connection WHERE id=:id AND project_id=:projectId.
//       Miss → return early; do NOT touch tokens or consents (the cross-
//       project bug this guard prevents).
//   (1) UPDATE oauth_refresh_token SET revoked=now WHERE
//       reference_id=:id AND revoked IS NULL  (defence-in-depth: no
//       new refreshes; enforcement is per-request `resolveConnection`).
//   (2) DELETE FROM oauth_consent WHERE reference_id=:id  (no silent
//       re-grant).
//   (3) DELETE FROM connection WHERE id=:id AND project_id=:projectId
//       (row gone → next `resolveConnection` misses → instant 403
//       regardless of JWT TTL). API keys cascade via the `connection_id`
//       FK (`onDelete: cascade` on the `api_key` table).
//
// This crosses the "Better Auth owns its tables" rule narrowly (revoke/
// delete by reference_id only, no shape changes) — a sanctioned
// exception, pinned by the generated `oauth_refresh_token` /
// `oauth_consent` shape so any upstream drift surfaces at the
// auth-schema regeneration step.
export async function deleteConnection(
  db: ControlDb,
  args: Readonly<{
    connectionId: ConnectionId;
    projectId: ProjectId;
    nowMs?: number;
  }>,
): Promise<void> {
  const [existing] = await db
    .select({ id: connection.id })
    .from(connection)
    .where(
      and(
        eq(connection.id, args.connectionId),
        eq(connection.projectId, args.projectId),
      ),
    )
    .limit(1);
  if (existing === undefined) return;
  const now = new Date(args.nowMs ?? Date.now());
  await db
    .update(oauthRefreshToken)
    .set({ revoked: now })
    .where(
      and(
        eq(oauthRefreshToken.referenceId, args.connectionId),
        isNull(oauthRefreshToken.revoked),
      ),
    );
  await db
    .delete(oauthConsent)
    .where(eq(oauthConsent.referenceId, args.connectionId));
  await db
    .delete(connection)
    .where(
      and(
        eq(connection.id, args.connectionId),
        eq(connection.projectId, args.projectId),
      ),
    );
}

// List a single Project's Connections — the per-Project audit/admin
// view. Roll-up counts (api-keys, active OAuth refresh tokens) make the
// list practically useful without N+1 lookups in the route.
export type ProjectConnectionRow = Readonly<{
  connectionId: ConnectionId;
  collectionSlug: CollectionSlug;
  name: string;
  isDefaultForCollection: boolean;
  apiKeyCount: number;
  activeGrantCount: number;
  createdAt: string;
}>;

export async function listProjectConnections(
  db: ControlDb,
  projectId: ProjectId,
): Promise<readonly ProjectConnectionRow[]> {
  const rows = await db
    .select({
      id: connection.id,
      collectionSlug: connection.collectionSlug,
      name: connection.name,
      isDefaultForCollection: connection.isDefaultForCollection,
      createdAt: connection.createdAt,
    })
    .from(connection)
    .where(eq(connection.projectId, projectId))
    .orderBy(asc(connection.createdAt));
  if (rows.length === 0) return [];

  // Roll up counts in parallel. Active-grant counts un-revoked refresh
  // tokens — the same set the per-request `resolveConnection` gate
  // would still treat as usable.
  const ids = rows.map((r) => r.id);
  const [keyCounts, grantCounts] = await Promise.all([
    db
      .select({ id: apiKey.connectionId, n: count() })
      .from(apiKey)
      .where(inArray(apiKey.connectionId, ids))
      .groupBy(apiKey.connectionId),
    db
      .select({ id: oauthRefreshToken.referenceId, n: count() })
      .from(oauthRefreshToken)
      .where(
        and(
          inArray(oauthRefreshToken.referenceId, ids),
          isNull(oauthRefreshToken.revoked),
        ),
      )
      .groupBy(oauthRefreshToken.referenceId),
  ]);

  const keysById = new Map(keyCounts.map((r) => [r.id, r.n]));
  // `reference_id` is nullable in the generated schema; the `inArray`
  // filter excludes NULLs at the row level but the column type still
  // permits them, so the map key coalesces defensively.
  const grantsById = new Map(grantCounts.map((r) => [r.id ?? "", r.n]));

  return rows.map((r) => ({
    connectionId: asConnectionId(r.id),
    collectionSlug: asCollectionSlug(r.collectionSlug),
    name: r.name,
    isDefaultForCollection: r.isDefaultForCollection,
    apiKeyCount: keysById.get(r.id) ?? 0,
    activeGrantCount: grantsById.get(r.id) ?? 0,
    createdAt: r.createdAt.toISOString(),
  }));
}
