import { env } from "cloudflare:test";
import { and, eq, isNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  createCanonicalConnection,
  deleteConnection,
  renameConnection,
} from "../src/control/connections";
import { connectControlDb } from "../src/control/db";
import { connection } from "../src/control/schema/app";
import {
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
} from "../src/control/schema/better-auth";
import { asCollectionSlug, asConnectionId } from "../src/ids";

import { createOrg, signUp } from "./_helpers";

// Regression: cross-tenant Connection administration.
//
// `renameConnection` and `deleteConnection` are admin-only, but the
// transport (`src/lib/server/connections.ts`) only knew that the caller
// was an owner of the URL-path project — the `connectionId` came from
// the client. The control layer mutated rows by `id` only, so an owner
// of project A who knew a connectionId from project B could rename or
// revoke B's Connection (and revoke its OAuth refresh tokens) just by
// passing the id.
//
// The fix: every mutation is scoped by `(connectionId, projectId)`. A
// wrong-project call is a silent no-op (matches 0 rows; the SELECT-
// then-cascade in `deleteConnection` returns early before touching the
// reference_id-keyed token/consent rows). These tests prove the scope.

async function seedRefreshToken(
  organizationId: string,
  userId: string,
  connectionId: string,
): Promise<void> {
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
}

describe("Connection admin scoping — cross-tenant guard", () => {
  it("renameConnection scoped to the wrong project is a silent no-op", async () => {
    const alice = await signUp("ct-rn-a");
    const bob = await signUp("ct-rn-b");
    const db = connectControlDb(env.DB);
    const orgA = await createOrg(alice, "Alice Org");
    const orgB = await createOrg(bob, "Bob Org");

    const bobConn = await createCanonicalConnection(db, {
      organizationId: orgB.organizationId,
      projectId: orgB.projectId,
      collectionSlug: asCollectionSlug("bob-secrets"),
      name: "Bob's Connection",
    });

    // Alice (owner of orgA / projectA) attempts to rename Bob's
    // connection while scoped to her own project. Must not touch B's row.
    await renameConnection(db, {
      connectionId: bobConn,
      projectId: orgA.projectId,
      name: "pwned",
    });

    const [row] = await db
      .select({ name: connection.name })
      .from(connection)
      .where(eq(connection.id, bobConn));
    expect(row?.name).toBe("Bob's Connection");
  });

  it("deleteConnection scoped to the wrong project does NOT touch the row or its tokens", async () => {
    const alice = await signUp("ct-del-a");
    const bob = await signUp("ct-del-b");
    const db = connectControlDb(env.DB);
    const orgA = await createOrg(alice, "Alice Del");
    const orgB = await createOrg(bob, "Bob Del");

    const bobConn = await createCanonicalConnection(db, {
      organizationId: orgB.organizationId,
      projectId: orgB.projectId,
      collectionSlug: asCollectionSlug("bob-vault"),
    });
    await seedRefreshToken(orgB.organizationId, bob, bobConn);

    // Cross-project delete: must early-return before the cascade. If the
    // SELECT-then-cascade guard regressed, the refresh-token revoke would
    // run first (keyed by reference_id only) and Bob's token would be
    // revoked even though the connection row survived.
    await deleteConnection(db, {
      connectionId: bobConn,
      projectId: orgA.projectId,
    });

    const [stillThere] = await db
      .select({ id: connection.id })
      .from(connection)
      .where(eq(connection.id, bobConn));
    expect(stillThere?.id).toBe(bobConn);

    const [unrevoked] = await db
      .select({ id: oauthRefreshToken.id })
      .from(oauthRefreshToken)
      .where(
        and(
          eq(oauthRefreshToken.referenceId, bobConn),
          isNull(oauthRefreshToken.revoked),
        ),
      );
    expect(unrevoked?.id).toBe(`rt-${bobConn}`);

    const [consent] = await db
      .select({ id: oauthConsent.id })
      .from(oauthConsent)
      .where(eq(oauthConsent.referenceId, bobConn));
    expect(consent?.id).toBe(`cn-${bobConn}`);
  });

  it("an unknown connectionId is a silent no-op (no oracle: same shape as cross-project)", async () => {
    const alice = await signUp("ct-unk");
    const db = connectControlDb(env.DB);
    const orgA = await createOrg(alice, "Alice Unk");

    // Should not throw; should not change anything. The behavior is the
    // shape the API contract relies on (no exception, no leaked oracle).
    await expect(
      renameConnection(db, {
        connectionId: asConnectionId("11111111-1111-1111-1111-111111111111"),
        projectId: orgA.projectId,
        name: "ignored",
      }),
    ).resolves.toBeUndefined();
    await expect(
      deleteConnection(db, {
        connectionId: asConnectionId("22222222-2222-2222-2222-222222222222"),
        projectId: orgA.projectId,
      }),
    ).resolves.toBeUndefined();
  });

  it("the correctly-scoped owner can still rename + delete their own connection", async () => {
    const bob = await signUp("ct-ok");
    const db = connectControlDb(env.DB);
    const org = await createOrg(bob, "Bob OK");
    const id = await createCanonicalConnection(db, {
      organizationId: org.organizationId,
      projectId: org.projectId,
      collectionSlug: asCollectionSlug("ok"),
      name: "before",
    });

    await renameConnection(db, {
      connectionId: id,
      projectId: org.projectId,
      name: "after",
    });
    const [renamed] = await db
      .select({ name: connection.name })
      .from(connection)
      .where(eq(connection.id, id));
    expect(renamed?.name).toBe("after");

    await deleteConnection(db, {
      connectionId: id,
      projectId: org.projectId,
    });
    const [gone] = await db
      .select({ id: connection.id })
      .from(connection)
      .where(eq(connection.id, id));
    expect(gone).toBeUndefined();
  });
});
