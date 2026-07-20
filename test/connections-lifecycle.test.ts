import { env } from "cloudflare:test";
import { and, eq, isNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  createCanonicalConnection,
  deleteConnection,
  listProjectConnections,
  renameConnection,
} from "../src/control/connections";
import { connectControlDb } from "../src/control/db";
import { readPendingConnect } from "../src/control/oauth-selection";
import { apiKey, connection } from "../src/control/schema/app";
import {
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
} from "../src/control/schema/better-auth";
import { asCollectionSlug } from "../src/ids";

import { createOrg, signUp } from "./_helpers";

// Seed an OAuth grant footprint we expect deleteConnection to clean up:
// one oauth_client (FK target), one oauth_refresh_token referencing the
// connection, one oauth_consent referencing the connection. Direct
// inserts mirror what Better Auth would persist after an authorize +
// token + consent — without driving the full handshake.
async function seedGrantFootprint(
  userId: string,
  connectionId: string,
): Promise<string> {
  const db = connectControlDb(env.DB);
  const clientId = `client-${connectionId}`;
  const now = new Date();
  await db.insert(oauthClient).values({
    id: clientId,
    clientId,
    name: "ci-client",
    type: "public",
    public: true,
    requirePKCE: true,
    redirectUris: ["http://127.0.0.1/cb"],
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "none",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(oauthRefreshToken).values({
    id: `rt-${connectionId}`,
    token: `tok-${connectionId}`,
    clientId,
    userId,
    referenceId: connectionId,
    scopes: ["openid"],
    expiresAt: new Date(now.getTime() + 24 * 3600 * 1000),
    createdAt: now,
  });
  await db.insert(oauthConsent).values({
    id: `cn-${connectionId}`,
    clientId,
    userId,
    referenceId: connectionId,
    scopes: ["openid"],
    createdAt: now,
    updatedAt: now,
  });
  return clientId;
}

describe("C4 — Connection lifecycle (CRUD)", () => {
  it("createCanonical: insert when absent, reuse on second click (partial unique index)", async () => {
    const userId = await signUp("c4cr");
    const db = connectControlDb(env.DB);
    const org = await createOrg(userId, "Org create");
    const slug = asCollectionSlug("marketing");
    const first = await createCanonicalConnection(db, {
      organizationId: org.organizationId,
      projectId: org.projectId,
      collectionSlug: slug,
    });
    const second = await createCanonicalConnection(db, {
      organizationId: org.organizationId,
      projectId: org.projectId,
      collectionSlug: slug,
    });
    expect(second).toBe(first); // no duplicate row
    const all = await listProjectConnections(db, org.projectId);
    expect(all).toHaveLength(1);
    expect(all[0]?.isDefaultForCollection).toBe(true);
  });

  it("an advanced (isDefault=false) Connection coexists with the canonical one (many-to-one)", async () => {
    const userId = await signUp("c4adv");
    const db = connectControlDb(env.DB);
    const org = await createOrg(userId, "Org adv");
    const slug = asCollectionSlug("hr");
    await createCanonicalConnection(db, {
      organizationId: org.organizationId,
      projectId: org.projectId,
      collectionSlug: slug,
    });
    // Advanced row, same (projectId, collectionSlug) but
    // isDefaultForCollection=false — the partial unique index does NOT
    // cover it.
    await db.insert(connection).values({
      organizationId: org.organizationId,
      projectId: org.projectId,
      collectionSlug: slug,
      name: "hr-advanced",
      isDefaultForCollection: false,
    });
    const all = await listProjectConnections(db, org.projectId);
    expect(all).toHaveLength(2);
    expect(all.filter((c) => c.isDefaultForCollection)).toHaveLength(1);
  });

  it("renameConnection: row write only", async () => {
    const userId = await signUp("c4rn");
    const db = connectControlDb(env.DB);
    const org = await createOrg(userId, "Org rn");
    const id = await createCanonicalConnection(db, {
      organizationId: org.organizationId,
      projectId: org.projectId,
      collectionSlug: asCollectionSlug("marketing"),
    });
    await renameConnection(db, {
      connectionId: id,
      projectId: org.projectId,
      name: "Marketing — production",
    });
    const [row] = await db
      .select({ name: connection.name })
      .from(connection)
      .where(eq(connection.id, id));
    expect(row?.name).toBe("Marketing — production");
  });

  it("deleteConnection: revokes oauth_refresh_token, drops oauth_consent, cascades api_key, drops connection — all idempotent", async () => {
    const userId = await signUp("c4del");
    const db = connectControlDb(env.DB);
    const org = await createOrg(userId, "Org del");
    const id = await createCanonicalConnection(db, {
      organizationId: org.organizationId,
      projectId: org.projectId,
      collectionSlug: asCollectionSlug("delme"),
    });
    // Footprint: a refresh token + consent referencing the Connection,
    // plus an api_key on it.
    await seedGrantFootprint(userId, id);
    await db.insert(apiKey).values({
      userId,
      organizationId: org.organizationId,
      connectionId: id,
      name: "k",
      tokenHash: "sha256:dummy",
      tokenPrefix: "cck_xxxxxxxx",
    });

    await deleteConnection(db, {
      connectionId: id,
      projectId: org.projectId,
      nowMs: 1_000_000,
    });

    // (1) refresh-token revoked timestamp set
    const rt = await db
      .select({ revoked: oauthRefreshToken.revoked })
      .from(oauthRefreshToken)
      .where(eq(oauthRefreshToken.referenceId, id));
    expect(rt).toHaveLength(1);
    expect(rt[0]?.revoked).toEqual(new Date(1_000_000));

    // (2) consent rows gone for this reference
    const consents = await db
      .select({ id: oauthConsent.id })
      .from(oauthConsent)
      .where(eq(oauthConsent.referenceId, id));
    expect(consents).toHaveLength(0);

    // (3) api_key rows gone (FK cascade from connection)
    const keys = await db
      .select({ id: apiKey.id })
      .from(apiKey)
      .where(eq(apiKey.connectionId, id));
    expect(keys).toHaveLength(0);

    // (4) connection row gone
    const conn = await db
      .select({ id: connection.id })
      .from(connection)
      .where(eq(connection.id, id));
    expect(conn).toHaveLength(0);

    // Re-run is a no-op (everything already done).
    await deleteConnection(db, {
      connectionId: id,
      projectId: org.projectId,
    });
    // Already-revoked refresh tokens are NOT re-revoked (predicate
    // `WHERE revoked IS NULL`) — the timestamp stays the FIRST one.
    const rt2 = await db
      .select({ revoked: oauthRefreshToken.revoked })
      .from(oauthRefreshToken)
      .where(eq(oauthRefreshToken.referenceId, id));
    expect(rt2[0]?.revoked).toEqual(new Date(1_000_000));
  });

  it("delete revoke predicate: an unrelated NULL-revoked refresh token is untouched", async () => {
    const userId = await signUp("c4iso");
    const db = connectControlDb(env.DB);
    const org = await createOrg(userId, "Org iso");
    const idA = await createCanonicalConnection(db, {
      organizationId: org.organizationId,
      projectId: org.projectId,
      collectionSlug: asCollectionSlug("a"),
    });
    const idB = await createCanonicalConnection(db, {
      organizationId: org.organizationId,
      projectId: org.projectId,
      collectionSlug: asCollectionSlug("b"),
    });
    await seedGrantFootprint(userId, idA);
    await seedGrantFootprint(userId, idB);

    await deleteConnection(db, {
      connectionId: idA,
      projectId: org.projectId,
    });

    const stillLive = await db
      .select({ id: oauthRefreshToken.id })
      .from(oauthRefreshToken)
      .where(
        and(
          eq(oauthRefreshToken.referenceId, idB),
          isNull(oauthRefreshToken.revoked),
        ),
      );
    expect(stillLive).toHaveLength(1);
  });

  it("listProjectConnections rolls up api-key + active-grant counts", async () => {
    const userId = await signUp("c4list");
    const db = connectControlDb(env.DB);
    const org = await createOrg(userId, "Org list");
    const id = await createCanonicalConnection(db, {
      organizationId: org.organizationId,
      projectId: org.projectId,
      collectionSlug: asCollectionSlug("counted"),
    });
    await db.insert(apiKey).values([
      {
        userId,
        organizationId: org.organizationId,
        connectionId: id,
        name: "k1",
        tokenHash: "sha256:c1",
        tokenPrefix: "cck_aaaaaaaa",
      },
      {
        userId,
        organizationId: org.organizationId,
        connectionId: id,
        name: "k2",
        tokenHash: "sha256:c2",
        tokenPrefix: "cck_bbbbbbbb",
      },
    ]);
    await seedGrantFootprint(userId, id);
    const [row] = await listProjectConnections(db, org.projectId);
    expect(row?.apiKeyCount).toBe(2);
    expect(row?.activeGrantCount).toBe(1);
  });
});

describe("C4 — pending-connect intent (the picker hint, NOT the binding)", () => {
  it("the intent is userId-keyed and TTL-expires", async () => {
    const userId = await signUp("c4pend");
    const db = connectControlDb(env.DB);
    const org = await createOrg(userId, "Org pend");
    const id = await createCanonicalConnection(db, {
      organizationId: org.organizationId,
      projectId: org.projectId,
      collectionSlug: asCollectionSlug("marketing"),
    });
    // The server-fn `connectThisCollection` calls writePendingConnect with
    // Date.now(); the helper test/oauth-selection.test.ts already
    // covers TTL + replace. Here we just assert the integration shape:
    // after creating, the userId resolves back to the Connection.
    const { writePendingConnect } =
      await import("../src/control/oauth-selection");
    await writePendingConnect(db, userId, id);
    expect(await readPendingConnect(db, userId)).toBe(id);
  });
});
