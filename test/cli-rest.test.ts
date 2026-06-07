import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  apiKeyDisplayPrefix,
  generateApiKeyToken,
  hashApiKeyToken,
} from "../src/control/api-keys";
import { connectControlDb } from "../src/control/db";
import { apiKey } from "../src/control/schema/app";
import { storeFor } from "../src/control/store-for";

import {
  createCollectionFor,
  createConnection,
  createOrg,
  docSlug,
  signUp,
} from "./_helpers";

const MEMBER_SLUG = "member-doc";
const OUTSIDER_SLUG = "outsider-doc";

// Mint an api-key bound to a fresh Connection, and seed the per-Project DO
// with two documents: one ATTACHED to the bound Collection (the key may
// touch it) and one that exists in the Project but is NOT in the Collection
// (the key must not). The key's authority is the Collection, not its tenant
// — these fixtures let every route assert that boundary.
async function mintKey(): Promise<string> {
  const ownerUserId = await signUp("v1");
  const db = connectControlDb(env.DB);
  const ref = await createOrg(ownerUserId, "Org v1");
  const conn = await createConnection({
    organizationId: ref.organizationId,
    projectId: ref.projectId,
  });
  await createCollectionFor(ref.projectId, conn.collectionSlug);

  const store = storeFor(env, ref.projectId);
  await store.saveDocument({
    slug: docSlug(MEMBER_SLUG),
    markdown: "seed",
    clientVersion: 0,
    changedBy: ownerUserId,
  });
  await store.attachDocument(
    conn.collectionSlug,
    docSlug(MEMBER_SLUG),
    0,
    ownerUserId,
  );
  await store.saveDocument({
    slug: docSlug(OUTSIDER_SLUG),
    markdown: "secret",
    clientVersion: 0,
    changedBy: ownerUserId,
  });

  const token = generateApiKeyToken();
  await db.insert(apiKey).values({
    userId: ownerUserId,
    organizationId: ref.organizationId,
    connectionId: conn.connectionId,
    name: "v1",
    tokenHash: await hashApiKeyToken(token),
    tokenPrefix: apiKeyDisplayPrefix(token),
  });
  return token;
}

// Mint a key whose bound Collection was NEVER created in the DO — the
// "collection gone" shape `collectionMembers` reports as `undefined`. The
// REST surface must fail CLOSED on this (403), never widen to the Project.
async function mintKeyWithoutCollection(): Promise<string> {
  const ownerUserId = await signUp("nc");
  const db = connectControlDb(env.DB);
  const ref = await createOrg(ownerUserId, "Org nc");
  const conn = await createConnection({
    organizationId: ref.organizationId,
    projectId: ref.projectId,
  });
  const token = generateApiKeyToken();
  await db.insert(apiKey).values({
    userId: ownerUserId,
    organizationId: ref.organizationId,
    connectionId: conn.connectionId,
    name: "nc",
    tokenHash: await hashApiKeyToken(token),
    tokenPrefix: apiKeyDisplayPrefix(token),
  });
  return token;
}

function call(
  path: string,
  token: string | undefined,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return SELF.fetch(`https://example.com${path}`, {
    method: body === undefined ? "GET" : "PUT",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("CLI REST surface (/api/v1/docs)", () => {
  it("rejects an unauthenticated request", async () => {
    expect((await call("/api/v1/docs", undefined)).status).toBe(401);
  });

  it("round-trips a collection-member document, and a stale push 409s", async () => {
    const token = await mintKey();

    const get = await call(`/api/v1/docs/${MEMBER_SLUG}`, token);
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ markdown: "seed", docVersion: 1 });

    const put = await call(`/api/v1/docs/${MEMBER_SLUG}`, token, {
      markdown: "updated",
      clientVersion: 1,
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ ok: true, docVersion: 2 });

    const list = await call("/api/v1/docs", token);
    expect(await list.json()).toMatchObject({
      documents: [{ slug: MEMBER_SLUG, docVersion: 2 }],
    });

    const stale = await call(`/api/v1/docs/${MEMBER_SLUG}`, token, {
      markdown: "again",
      clientVersion: 0,
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      conflict: true,
      currentVersion: 2,
    });
  });

  it("lists only the bound collection's members", async () => {
    const token = await mintKey();
    const body: { documents: readonly { slug: string }[] } = await (
      await call("/api/v1/docs", token)
    ).json();
    const slugs = body.documents.map((d) => d.slug);
    expect(slugs).toContain(MEMBER_SLUG);
    expect(slugs).not.toContain(OUTSIDER_SLUG);
  });

  it("404s a document outside the bound collection (no existence leak)", async () => {
    const token = await mintKey();
    expect((await call(`/api/v1/docs/${OUTSIDER_SLUG}`, token)).status).toBe(
      404,
    );
  });

  it("403s a write to a document outside the bound collection", async () => {
    const token = await mintKey();
    const r = await call(`/api/v1/docs/${OUTSIDER_SLUG}`, token, {
      markdown: "tamper",
      clientVersion: 1,
    });
    expect(r.status).toBe(403);
  });

  it("creates a brand-new slug into the bound collection, and it round-trips", async () => {
    const token = await mintKey();
    const created = await call("/api/v1/docs/brand-new", token, {
      markdown: "fresh",
      clientVersion: 0,
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ ok: true, docVersion: 1 });

    // The new doc is now a member of the bound collection: readable + listed.
    const get = await call("/api/v1/docs/brand-new", token);
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({
      markdown: "fresh",
      docVersion: 1,
    });

    const body: { documents: readonly { slug: string }[] } = await (
      await call("/api/v1/docs", token)
    ).json();
    expect(body.documents.map((d) => d.slug)).toContain("brand-new");
  });

  it("404s a wholly missing document", async () => {
    const token = await mintKey();
    expect((await call("/api/v1/docs/nope", token)).status).toBe(404);
  });

  it("400s a malformed write body", async () => {
    const token = await mintKey();
    // Missing `markdown` — fails DocPushBody validation after auth/scope.
    const r = await call(`/api/v1/docs/${MEMBER_SLUG}`, token, {
      clientVersion: 0,
    });
    expect(r.status).toBe(400);
  });

  it("fails closed (403) on every route when the bound collection is gone", async () => {
    const token = await mintKeyWithoutCollection();
    expect((await call("/api/v1/docs", token)).status).toBe(403);
    expect((await call("/api/v1/docs/anything", token)).status).toBe(403);
    const write = await call("/api/v1/docs/anything", token, {
      markdown: "x",
      clientVersion: 0,
    });
    expect(write.status).toBe(403);
  });
});
