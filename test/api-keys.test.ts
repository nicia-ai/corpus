import { env, SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  apiKeyDisplayPrefix,
  generateApiKeyToken,
  hashApiKeyToken,
} from "../src/control/api-keys";
import { connectControlDb } from "../src/control/db";
import { apiKey } from "../src/control/schema/app";

import {
  createConnection,
  createCollectionFor,
  createOrg,
  signUp,
} from "./_helpers";

// Mint a usable MCP API key bound to a fresh user's Connection (v4: a
// key hangs off a Connection, not a Project), crossing the same trust
// boundary the createApiKey server fn does (generate → hash → store
// hash only). Also creates the bound Collection in the per-Project DO
// so the respondMcp preflight finds it.
async function mintKey(name = "ci") {
  const ownerUserId = await signUp("ak");
  const db = connectControlDb(env.DB);
  const ref = await createOrg(ownerUserId, `Org ${name}`);
  const conn = await createConnection({
    organizationId: ref.organizationId,
    projectId: ref.projectId,
  });
  await createCollectionFor(ref.projectId, conn.collectionSlug);
  const token = generateApiKeyToken();
  await db.insert(apiKey).values({
    userId: ownerUserId,
    organizationId: ref.organizationId,
    connectionId: conn.connectionId,
    name,
    tokenHash: await hashApiKeyToken(token),
    tokenPrefix: apiKeyDisplayPrefix(token),
  });
  return { token, ref, conn };
}

function rpc(token: string | undefined, body: unknown) {
  return SELF.fetch("https://example.com/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

describe("API-key token helpers", () => {
  it("generates a prefixed, high-entropy token", () => {
    const a = generateApiKeyToken();
    const b = generateApiKeyToken();
    expect(a.startsWith("cck_")).toBe(true);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(30);
    expect(apiKeyDisplayPrefix(a)).toBe(a.slice(0, 12));
  });

  it("hashes deterministically and never returns the plaintext", async () => {
    const t = generateApiKeyToken();
    const h1 = await hashApiKeyToken(t);
    const h2 = await hashApiKeyToken(t);
    expect(h1).toBe(h2);
    expect(h1.startsWith("sha256:")).toBe(true);
    expect(h1).not.toContain(t);
  });
});

describe("MCP API-key auth path", () => {
  it("authenticates a valid key and routes to its bound project", async () => {
    const { token } = await mintKey("valid");
    const res = await rpc(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { tools: { name: string }[] };
    };
    expect(body.result.tools.map((t) => t.name)).toContain(
      "read_document_meta",
    );

    // Reaches a real ProjectStore for the bound project (empty, fresh).
    const docs = await rpc(token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_documents", arguments: {} },
    });
    const dj = (await docs.json()) as {
      result: { content: { text: string }[] };
    };
    expect(dj.result.content[0]?.text).toBe("[]");
  });

  it("rejects an unknown cck_ token with 401", async () => {
    const res = await rpc(generateApiKeyToken(), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(res.status).toBe(401);
  });

  it("rejects a revoked (deleted) key with 401", async () => {
    const { token } = await mintKey("revoked");
    const hash = await hashApiKeyToken(token);
    await connectControlDb(env.DB)
      .delete(apiKey)
      .where(eq(apiKey.tokenHash, hash));
    const res = await rpc(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(res.status).toBe(401);
  });
});
