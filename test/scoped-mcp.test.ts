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
  asCallerRef,
  asCollectionSlug,
  asDocumentSlug,
  type ConnectionId,
} from "../src/ids";
import type { McpExecutor } from "../src/mcp";
import { scopedExecutor } from "../src/scoped-executor";

import {
  createConnection,
  createCollectionFor,
  createOrg,
  signUp,
} from "./_helpers";

// — scopedExecutor unit tests — pure filtering against a stub
//   McpExecutor, no DO. Verifies the read-side scope rules.

function stubExec(): Omit<McpExecutor, "callerRef" | "baseUrl" | "projectId"> {
  return {
    listCollections: () =>
      Promise.resolve([
        { slug: "marketing", name: "Marketing" },
        { slug: "hr", name: "HR" },
      ]),
    listDocuments: () =>
      Promise.resolve([
        {
          slug: "brand-voice",
          title: "Brand voice",
          docVersion: 1,
          size: 10,
          path: "brand-voice.md",
        },
        {
          slug: "handbook",
          title: "Handbook",
          docVersion: 1,
          size: 20,
          path: "hr/handbook.md",
        },
        {
          slug: "salaries",
          title: "Salaries",
          docVersion: 1,
          size: 30,
          path: "hr/salaries.md",
        },
      ]),
    collectionMembers: (slug) =>
      Promise.resolve(
        slug === "marketing"
          ? ["brand-voice"]
          : slug === "hr"
            ? ["handbook", "salaries"]
            : undefined,
      ),
    readCollection: (slug) =>
      slug === "marketing"
        ? Promise.resolve({
            found: true as const,
            corpus: "# brand-voice\n",
            documents: [{ slug: "brand-voice", docVersion: 1, size: 10 }],
          })
        : Promise.resolve({ found: false as const }),
    getDocument: (slug) => {
      const all: Record<string, string> = {
        "brand-voice": "marketing-only",
        handbook: "hr-only",
        salaries: "hr-only-secret",
      };
      const m = all[slug as unknown as string];
      return Promise.resolve(
        m === undefined
          ? undefined
          : { slug, title: slug, markdown: m, docVersion: 1 },
      );
    },
    verifyHistory: () => Promise.resolve({ ok: true }),
    recordRead: () => Promise.resolve(),
    suggestEdit: () =>
      Promise.resolve({ ok: false as const, reason: "missing" as const }),
    suggestCreate: () =>
      Promise.resolve({ ok: false as const, reason: "invalid" as const }),
    proposalResult: () => Promise.resolve({ found: false }),
    collectionOutline: (slug) =>
      slug === "marketing"
        ? Promise.resolve({
            found: true as const,
            collection: "marketing",
            name: "Marketing",
            documents: [
              {
                slug: "brand-voice",
                path: "brand-voice.md",
                title: "Brand voice",
                docVersion: 1,
                delivery: "core",
                links: [
                  // member-link → preserved
                  {
                    target: "brand-voice.md",
                    kind: "path",
                    resolvedPath: "brand-voice.md",
                    documentSlug: "brand-voice",
                    inCollection: true,
                  },
                  // out-of-scope target → must collapse
                  {
                    target: "../hr/handbook.md",
                    kind: "path",
                    resolvedPath: "hr/handbook.md",
                    documentSlug: "handbook",
                    inCollection: false,
                  },
                ],
              },
            ],
          })
        : Promise.resolve({ found: false as const }),
  };
}

describe("scopedExecutor confines reads to the bound Collection", () => {
  it("listCollections → only the bound Collection (sibling Collections hidden)", async () => {
    const exec = scopedExecutor(
      stubExec(),
      asCollectionSlug("marketing"),
      ["brand-voice"],
      asCallerRef("apikey:test"),
    );
    const cols = await exec.listCollections();
    expect(cols.map((c) => c.slug)).toEqual(["marketing"]);
  });

  it("listDocuments → only the member set (sibling-Collection docs invisible)", async () => {
    const exec = scopedExecutor(
      stubExec(),
      asCollectionSlug("marketing"),
      ["brand-voice"],
      asCallerRef("apikey:test"),
    );
    const docs = await exec.listDocuments();
    expect(docs.map((d) => d.slug)).toEqual(["brand-voice"]);
  });

  it("readCollection / collectionOutline of a non-bound slug → found:false", async () => {
    const exec = scopedExecutor(
      stubExec(),
      asCollectionSlug("marketing"),
      ["brand-voice"],
      asCallerRef("apikey:test"),
    );
    expect(await exec.readCollection(asCollectionSlug("hr"))).toEqual({
      found: false,
    });
    expect(await exec.collectionOutline(asCollectionSlug("hr"))).toEqual({
      found: false,
    });
  });

  it("getDocument → non-member returns undefined (not 'forbidden' — indistinguishable from unknown)", async () => {
    const exec = scopedExecutor(
      stubExec(),
      asCollectionSlug("marketing"),
      ["brand-voice"],
      asCallerRef("apikey:test"),
    );
    expect(await exec.getDocument(asDocumentSlug("brand-voice"))).toBeDefined();
    expect(await exec.getDocument(asDocumentSlug("handbook"))).toBeUndefined();
    expect(await exec.getDocument(asDocumentSlug("salaries"))).toBeUndefined();
  });

  it("out-of-scope link target collapses to null (no slug leak)", async () => {
    const exec = scopedExecutor(
      stubExec(),
      asCollectionSlug("marketing"),
      ["brand-voice"],
      asCallerRef("apikey:test"),
    );
    const o = await exec.collectionOutline(asCollectionSlug("marketing"));
    expect(o.found).toBe(true);
    if (!o.found) return;
    const links = o.documents[0]?.links ?? [];
    const inScope = links.find((l) => l.documentSlug === "brand-voice");
    expect(inScope?.inCollection).toBe(true);
    const outOfScope = links.find((l) => l.target === "../hr/handbook.md");
    expect(outOfScope).toEqual({
      target: "../hr/handbook.md",
      kind: "path",
      resolvedPath: null,
      documentSlug: null,
      inCollection: false,
    });
  });

  it("scopedExecutor.collectionMembers serves only the bound slug", async () => {
    const exec = scopedExecutor(
      stubExec(),
      asCollectionSlug("marketing"),
      ["brand-voice"],
      asCallerRef("apikey:test"),
    );
    expect(await exec.collectionMembers(asCollectionSlug("marketing"))).toEqual(
      ["brand-voice"],
    );
    expect(
      await exec.collectionMembers(asCollectionSlug("hr")),
    ).toBeUndefined();
  });
});

// — export_bundle is not on the agent surface (it's an owner path).

describe("export_bundle absent from the MCP surface", () => {
  it("tools/list does not advertise export_bundle", async () => {
    const { token } = await mintBoundKey("toolslist");
    const res = await rpc(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const body = (await res.json()) as {
      result: { tools: { name: string }[] };
    };
    const names = body.result.tools.map((t) => t.name);
    expect(names).not.toContain("export_bundle");
    expect(names).toContain("list_documents");
  });

  it("calling export_bundle → method-not-found (-32601)", async () => {
    const { token } = await mintBoundKey("expcall");
    const res = await rpc(token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "export_bundle", arguments: {} },
    });
    const body = (await res.json()) as {
      error?: { code: number; message?: string };
    };
    expect(body.error?.code).toBe(-32601);
  });

  it("McpExecutor has no exportBundle member (type-level guard)", () => {
    type HasExportBundle = "exportBundle" extends keyof McpExecutor
      ? true
      : false;
    const x: HasExportBundle = false;
    expect(x).toBe(false);
  });
});

// — respondMcp preflight: a missing bound Collection is a transport
//   403, not a JSON-RPC 200 not-found that could read as "empty Collection."

describe("respondMcp bound-Collection preflight", () => {
  it("stale/bogus bound collectionSlug → HTTP 403", async () => {
    // Mint a key whose Connection points at a collectionSlug that was
    // NEVER created in the DO — the reachable case for v4 (Collection
    // delete is unreachable today; see Locked decisions).
    const ownerUserId = await signUp("preflight");
    const db = connectControlDb(env.DB);
    const org = await createOrg(ownerUserId, "Org pre");
    const conn = await createConnection({
      organizationId: org.organizationId,
      projectId: org.projectId,
      collectionSlug: "never-created",
    });
    // Deliberately do NOT call createCollectionFor.
    const token = generateApiKeyToken();
    await db.insert(apiKey).values({
      userId: ownerUserId,
      organizationId: org.organizationId,
      connectionId: conn.connectionId,
      name: "stale",
      tokenHash: await hashApiKeyToken(token),
      tokenPrefix: apiKeyDisplayPrefix(token),
    });
    const res = await rpc(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(res.status).toBe(403);
  });
});

// — North-star acceptance: a bound credential never reveals out-of-
//   scope by name, slug, link, or count. Two layers kept distinct —
//   this test is the SERVER side (two credentials with different
//   connections resolve to different scopes). The external client-
//   isolation smoke is unrunnable in this sandbox.

describe("north-star: bound credential confinement (server side)", () => {
  it("Marketing key sees only Marketing; HR key sees only HR (no Handbook leak)", async () => {
    const ownerUserId = await signUp("ns");
    const db = connectControlDb(env.DB);
    const org = await createOrg(ownerUserId, "North-Star Co");
    const store = storeFor(env, org.projectId);

    // Seed: brand-voice/messaging in Marketing; handbook NOT in
    // Marketing (project-wide doc); salaries in HR.
    for (const s of [
      "brand-voice",
      "messaging",
      "employee-handbook",
      "salaries",
    ]) {
      await store.saveDocument({
        slug: asDocumentSlug(s),
        markdown: `# ${s}\nbody of ${s}`,
        clientVersion: 0,
        changedBy: "seed",
      });
    }
    await createCollectionFor(org.projectId, asCollectionSlug("marketing"));
    await createCollectionFor(org.projectId, asCollectionSlug("hr"));
    await store.attachDocument(
      asCollectionSlug("marketing"),
      asDocumentSlug("brand-voice"),
      1,
      "seed",
    );
    await store.attachDocument(
      asCollectionSlug("marketing"),
      asDocumentSlug("messaging"),
      2,
      "seed",
    );
    await store.attachDocument(
      asCollectionSlug("hr"),
      asDocumentSlug("employee-handbook"),
      1,
      "seed",
    );
    await store.attachDocument(
      asCollectionSlug("hr"),
      asDocumentSlug("salaries"),
      2,
      "seed",
    );

    // Two Connections (Marketing, HR) → two credentials.
    const marketingConn = await createConnection({
      organizationId: org.organizationId,
      projectId: org.projectId,
      collectionSlug: "marketing",
      isDefaultForCollection: true,
    });
    const hrConn = await createConnection({
      organizationId: org.organizationId,
      projectId: org.projectId,
      collectionSlug: "hr",
      isDefaultForCollection: true,
    });
    const mktToken = await insertKey(
      ownerUserId,
      org.organizationId,
      marketingConn.connectionId,
      "mkt",
    );
    const hrToken = await insertKey(
      ownerUserId,
      org.organizationId,
      hrConn.connectionId,
      "hr",
    );
    // Two distinct credentials, two distinct Connections — the precise
    // setup the design's north-star asserts.
    expect(mktToken).not.toBe(hrToken);
    expect(marketingConn.connectionId).not.toBe(hrConn.connectionId);

    // Marketing — neither Handbook nor Salaries appears in ANY surface.
    await assertScopeContains(mktToken, "marketing", [
      "brand-voice",
      "messaging",
    ]);
    await assertScopeForbids(mktToken, "marketing", [
      "employee-handbook",
      "salaries",
    ]);

    // HR — neither Marketing doc appears.
    await assertScopeContains(hrToken, "hr", ["employee-handbook", "salaries"]);
    await assertScopeForbids(hrToken, "hr", ["brand-voice", "messaging"]);
  });
});

// — helpers used by the suite below —

function rpc(token: string, body: unknown) {
  return SELF.fetch("https://example.com/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

async function mintBoundKey(name: string) {
  const ownerUserId = await signUp("bound");
  const db = connectControlDb(env.DB);
  const org = await createOrg(ownerUserId, `Org ${name}`);
  const conn = await createConnection({
    organizationId: org.organizationId,
    projectId: org.projectId,
  });
  await createCollectionFor(org.projectId, conn.collectionSlug);
  const token = generateApiKeyToken();
  await db.insert(apiKey).values({
    userId: ownerUserId,
    organizationId: org.organizationId,
    connectionId: conn.connectionId,
    name,
    tokenHash: await hashApiKeyToken(token),
    tokenPrefix: apiKeyDisplayPrefix(token),
  });
  return { token, conn };
}

async function insertKey(
  userId: string,
  organizationId: string,
  connectionId: ConnectionId,
  name: string,
): Promise<string> {
  const token = generateApiKeyToken();
  await connectControlDb(env.DB)
    .insert(apiKey)
    .values({
      userId,
      organizationId,
      connectionId,
      name,
      tokenHash: await hashApiKeyToken(token),
      tokenPrefix: apiKeyDisplayPrefix(token),
    });
  return token;
}

type JsonRpcOk = Readonly<{
  result?: { content?: readonly { type: string; text?: string }[] };
  error?: { code: number; message?: string };
}>;

async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<JsonRpcOk> {
  const res = await rpc(token, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  return (await res.json()) as JsonRpcOk;
}

function textOf(body: JsonRpcOk): string {
  return body.result?.content?.[0]?.text ?? "";
}

// Walk every read surface a scoped credential exposes and assert the
// expected member-set IS visible.
async function assertScopeContains(
  token: string,
  bound: string,
  members: readonly string[],
): Promise<void> {
  const ctxs = JSON.parse(
    textOf(await callTool(token, "list_collections")),
  ) as {
    slug: string;
  }[];
  expect(ctxs.map((c) => c.slug)).toEqual([bound]);

  const docs = JSON.parse(textOf(await callTool(token, "list_documents"))) as {
    slug: string;
  }[];
  expect(new Set(docs.map((d) => d.slug))).toEqual(new Set(members));

  for (const slug of members) {
    expect(
      textOf(await callTool(token, "read_document", { slug })).length,
    ).toBeGreaterThan(0);
  }
}

// Assert the forbidden slugs DO NOT appear in any read surface.
async function assertScopeForbids(
  token: string,
  bound: string,
  forbidden: readonly string[],
): Promise<void> {
  const docs = textOf(await callTool(token, "list_documents"));
  for (const slug of forbidden) expect(docs).not.toContain(slug);

  const ctxs = textOf(await callTool(token, "list_collections"));
  for (const slug of forbidden) expect(ctxs).not.toContain(slug);

  const resList = await rpc(token, {
    jsonrpc: "2.0",
    id: 99,
    method: "resources/list",
    params: {},
  });
  const resListBody = JSON.stringify(await resList.json());
  for (const slug of forbidden) expect(resListBody).not.toContain(slug);

  for (const slug of forbidden) {
    const body = await callTool(token, "read_document", { slug });
    expect(body.error?.code).toBe(-32004);
  }

  const otherCtx = bound === "marketing" ? "hr" : "marketing";
  const rc = await callTool(token, "read_collection", {
    collectionSlug: otherCtx,
  });
  expect(rc.error?.code).toBe(-32004);
}
