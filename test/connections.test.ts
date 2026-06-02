import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  apiKeyDisplayPrefix,
  generateApiKeyToken,
  hashApiKeyToken,
} from "../src/control/api-keys";
import {
  resolveApiKey,
  resolveConnection,
} from "../src/control/connection-resolution";
import { upsertCanonicalConnection } from "../src/control/connections";
import { connectControlDb } from "../src/control/db";
import { deleteProject } from "../src/control/project-admin";
import { apiKey, connection } from "../src/control/schema/app";
import { member } from "../src/control/schema/better-auth";
import { asCollectionSlug } from "../src/ids";

import { createConnection, createOrg, signUp } from "./_helpers";

// A credential resolves to a Connection → (projectId, collectionSlug),
// gated by a LIVE user-bound membership join (D1 only — Collection
// existence is the respondMcp preflight's contract, not asserted here).
async function seed(name: string) {
  const userId = await signUp("conn");
  const db = connectControlDb(env.DB);
  const org = await createOrg(userId, `Org ${name}`);
  const conn = await createConnection({
    organizationId: org.organizationId,
    projectId: org.projectId,
    collectionSlug: `marketing-${name}`,
  });
  const token = generateApiKeyToken();
  await db.insert(apiKey).values({
    userId,
    organizationId: org.organizationId,
    connectionId: conn.connectionId,
    name,
    tokenHash: await hashApiKeyToken(token),
    tokenPrefix: apiKeyDisplayPrefix(token),
  });
  return { db, userId, org, conn, token };
}

describe("credential resolves to a Connection", () => {
  it("resolveApiKey → ConnectionRef with the bound (projectId, collectionSlug) + apiKeyId", async () => {
    const { org, conn, token } = await seed("ak");
    const ref = await resolveApiKey(connectControlDb(env.DB), token);
    expect(ref).toEqual({
      organizationId: org.organizationId,
      projectId: org.projectId,
      userId: expect.any(String),
      role: "owner",
      connectionId: conn.connectionId,
      collectionSlug: conn.collectionSlug,
      // api_key.id populated for namespaced CallerRef construction.
      apiKeyId: expect.any(String),
    });
  });

  it("resolveConnection (OAuth path) → ConnectionRef WITHOUT apiKeyId", async () => {
    // Invariant: only the api-key path populates apiKeyId. The OAuth
    // path uses userId for the namespace and leaves apiKeyId undefined
    // so a downstream check can build the right CallerRef.
    const { userId, conn } = await seed("oauth-noak");
    const ref = await resolveConnection(connectControlDb(env.DB), {
      userId,
      connectionId: conn.connectionId,
    });
    expect(ref?.apiKeyId).toBeUndefined();
  });

  it("resolveConnection → ConnectionRef for {userId, connectionId}", async () => {
    const { userId, org, conn } = await seed("oauth");
    const ref = await resolveConnection(connectControlDb(env.DB), {
      userId,
      connectionId: conn.connectionId,
    });
    expect(ref?.projectId).toBe(org.projectId);
    expect(ref?.collectionSlug).toBe(conn.collectionSlug);
    expect(ref?.connectionId).toBe(conn.connectionId);
  });

  it("membership removed → both resolvers yield undefined", async () => {
    const { db, userId, conn, token } = await seed("nomember");
    await db.delete(member).where(eq(member.userId, userId));
    expect(await resolveApiKey(db, token)).toBeUndefined();
    expect(
      await resolveConnection(db, { userId, connectionId: conn.connectionId }),
    ).toBeUndefined();
  });

  it("project soft-deleted → both resolvers yield undefined", async () => {
    const { db, userId, org, conn, token } = await seed("delproj");
    await deleteProject(db, org.projectId);
    expect(await resolveApiKey(db, token)).toBeUndefined();
    expect(
      await resolveConnection(db, { userId, connectionId: conn.connectionId }),
    ).toBeUndefined();
  });

  it("connection deleted → both resolvers yield undefined (next-request kill)", async () => {
    const { db, userId, conn, token } = await seed("delconn");
    await db.delete(connection).where(eq(connection.id, conn.connectionId));
    expect(await resolveApiKey(db, token)).toBeUndefined();
    expect(
      await resolveConnection(db, { userId, connectionId: conn.connectionId }),
    ).toBeUndefined();
  });

  it("role owner→member still resolves (read is role-agnostic)", async () => {
    const { db, userId, org, conn, token } = await seed("rolechange");
    await db
      .update(member)
      .set({ role: "member" })
      .where(
        and(
          eq(member.userId, userId),
          eq(member.organizationId, org.organizationId),
        ),
      );
    const viaKey = await resolveApiKey(db, token);
    expect(viaKey?.role).toBe("member");
    expect(viaKey?.collectionSlug).toBe(conn.collectionSlug);
    const viaConn = await resolveConnection(db, {
      userId,
      connectionId: conn.connectionId,
    });
    expect(viaConn?.role).toBe("member");
  });

  it("empty/bogus identity → resolveConnection undefined (fail closed)", async () => {
    const db = connectControlDb(env.DB);
    expect(
      await resolveConnection(db, { userId: "", connectionId: "x" }),
    ).toBeUndefined();
    expect(
      await resolveConnection(db, { userId: "u", connectionId: "" }),
    ).toBeUndefined();
    expect(
      await resolveConnection(db, {
        userId: "nope",
        connectionId: "nope",
      }),
    ).toBeUndefined();
  });
});

// Regression: the existing tests above use the createConnection helper
// in _helpers.ts which does a direct insert into the connection table,
// bypassing upsertCanonicalConnection's ON CONFLICT path entirely. The
// "Connect this collection" button in the UI exercises upsertCanonicalConnection
// directly and a mismatch between the migration's partial-index predicate
// (qualified `"connection"."is_default_for_collection"`) and the conflict
// clause's targetWhere (had been unqualified `"is_default_for_collection"`)
// caused SQLite to reject the insert with "no unique or exclusion
// constraint matching the ON CONFLICT specification". The tests below
// exercise upsertCanonicalConnection through the real D1 path so this
// can't silently break again.
describe("upsertCanonicalConnection (reuse-or-create — select-then-insert)", () => {
  it("first call inserts a canonical (default) row", async () => {
    const userId = await signUp("ccc-first");
    const org = await createOrg(userId, "Org CCC first");
    const db = connectControlDb(env.DB);
    const id = await upsertCanonicalConnection(db, {
      organizationId: org.organizationId,
      projectId: org.projectId,
      collectionSlug: asCollectionSlug("sales-agent"),
    });
    expect(id).toBeTruthy();
    const [row] = await db
      .select()
      .from(connection)
      .where(eq(connection.id, id));
    expect(row?.collectionSlug).toBe("sales-agent");
    expect(row?.isDefaultForCollection).toBe(true);
  });

  it("second call for the same (projectId, collectionSlug) reuses the canonical row", async () => {
    const userId = await signUp("ccc-reuse");
    const org = await createOrg(userId, "Org CCC reuse");
    const db = connectControlDb(env.DB);
    const first = await upsertCanonicalConnection(db, {
      organizationId: org.organizationId,
      projectId: org.projectId,
      collectionSlug: asCollectionSlug("alerts"),
    });
    const second = await upsertCanonicalConnection(db, {
      organizationId: org.organizationId,
      projectId: org.projectId,
      collectionSlug: asCollectionSlug("alerts"),
      name: "renamed",
    });
    expect(second).toBe(first);
    const rows = await db
      .select()
      .from(connection)
      .where(
        and(
          eq(connection.projectId, org.projectId),
          eq(connection.collectionSlug, "alerts"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("renamed");
  });

  it("same collection across two DIFFERENT projects yields two distinct canonical rows", async () => {
    const userId = await signUp("ccc-cross");
    const orgA = await createOrg(userId, "Org CCC A");
    const orgB = await createOrg(userId, "Org CCC B");
    const db = connectControlDb(env.DB);
    const a = await upsertCanonicalConnection(db, {
      organizationId: orgA.organizationId,
      projectId: orgA.projectId,
      collectionSlug: asCollectionSlug("docs"),
    });
    const b = await upsertCanonicalConnection(db, {
      organizationId: orgB.organizationId,
      projectId: orgB.projectId,
      collectionSlug: asCollectionSlug("docs"),
    });
    expect(a).not.toBe(b);
  });
});
