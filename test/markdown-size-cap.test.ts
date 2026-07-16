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
import { asCallerRef, asProjectId } from "../src/ids";
import { handleMcp, RpcSchema } from "../src/mcp";
import { ERR } from "../src/mcp/protocol";
import { scopedExecutor } from "../src/scoped-executor";
import {
  MARKDOWN_TOO_LARGE_MESSAGE,
  MAX_MARKDOWN_BYTES,
  markdownBodyZ,
} from "../src/util";

import {
  colSlug,
  createCollectionFor,
  createConnection,
  createOrg,
  docSlug,
  freshStore,
  signUp,
} from "./_helpers";

// The markdown byte cap (MAX_MARKDOWN_BYTES, src/util.ts). DO SQLite has a
// hard ~2MB per-value limit; before the cap an oversized write died
// mid-transaction as an opaque storage error. The authoritative check is
// UTF-8 bytes in the DO write commands; every transport carries a cheap
// UTF-16 length pre-filter that CANNOT catch multi-byte overflows — so each
// surface is proven against both an over-length body (the pre-filter) and a
// multi-byte body that only the DO byte check can refuse.

const by = "size-cap";

// One code unit over the cap; 1 byte per char, so over in both units.
const OVERSIZED = "x".repeat(MAX_MARKDOWN_BYTES + 1);
// 600k UTF-16 code units (passes every length gate) but 1.2MB of UTF-8 —
// only the DO's authoritative byte check refuses this one.
const MULTIBYTE_OVERSIZED = "é".repeat(600_000);

describe("markdown byte cap — DO commands (the authority)", () => {
  it("saveDocument refuses an oversized body before any write", async () => {
    const store = freshStore("cap");
    const r = await store.saveDocument({
      slug: docSlug("big"),
      markdown: OVERSIZED,
      clientVersion: 0,
      changedBy: by,
    });
    expect(r).toEqual({ ok: false, tooLarge: true });
    expect(await store.getDocument(docSlug("big"))).toBeUndefined();
  });

  it("saveDocument accepts a body exactly at the cap", async () => {
    const store = freshStore("cap");
    const r = await store.saveDocument({
      slug: docSlug("edge"),
      markdown: "y".repeat(MAX_MARKDOWN_BYTES),
      clientVersion: 0,
      changedBy: by,
    });
    expect(r).toEqual({ ok: true, docVersion: 1 });
  });

  it("saveDocument measures UTF-8 bytes, not UTF-16 length", async () => {
    const store = freshStore("cap");
    const r = await store.saveDocument({
      slug: docSlug("multibyte"),
      markdown: MULTIBYTE_OVERSIZED,
      clientVersion: 0,
      changedBy: by,
    });
    expect(r).toEqual({ ok: false, tooLarge: true });
  });

  it("createSuggestion refuses an oversized proposal, storing nothing", async () => {
    const store = freshStore("cap");
    await store.saveDocument({
      slug: docSlug("doc"),
      markdown: "small",
      clientVersion: 0,
      changedBy: by,
    });
    const r = await store.createSuggestion({
      slug: docSlug("doc"),
      proposedMarkdown: OVERSIZED,
      clientVersion: 1,
      createdBy: by,
    });
    expect(r).toEqual({ ok: false, reason: "too-large" });
    expect(await store.listSuggestions(docSlug("doc"))).toHaveLength(0);
  });

  it("createDocProposal refuses an oversized body, storing nothing", async () => {
    const store = freshStore("cap");
    const r = await store.createDocProposal({
      slug: docSlug("proposed-doc"),
      proposedMarkdown: OVERSIZED,
      createdBy: by,
    });
    expect(r).toEqual({ ok: false, reason: "too-large" });
    expect(await store.listCreateProposals()).toHaveLength(0);
  });

  it("a partial acceptance whose splice would exceed the cap is refused, not committed", async () => {
    // Base and proposal are each under the cap; accepting ONLY the insert
    // hunk splices the new block into the still-present old one → over.
    const store = freshStore("cap");
    const base = `intro\n\n${"a".repeat(600_000)}\n\nmiddle anchor\n\ntail`;
    const proposed = `intro\n\nmiddle anchor\n\n${"c".repeat(450_000)}\n\ntail`;
    await store.saveDocument({
      slug: docSlug("splice"),
      markdown: base,
      clientVersion: 0,
      changedBy: by,
    });
    const created = await store.createSuggestion({
      slug: docSlug("splice"),
      proposedMarkdown: proposed,
      clientVersion: 1,
      createdBy: by,
    });
    if (!created.ok) throw new Error("suggestion unexpectedly refused");
    const [s] = await store.listSuggestions(docSlug("splice"));
    const insert = s?.hunks.find((h) => h.op === "insert");
    if (insert === undefined) throw new Error("expected an insert hunk");
    expect(
      await store.setHunkDecision({ hunkId: insert.id, decision: "accepted" }),
    ).toEqual({ ok: true });

    const applied = await store.applySuggestion({
      suggestionId: created.suggestionId,
      appliedBy: by,
    });
    expect(applied).toEqual({ ok: false, reason: "too-large" });
    // The whole apply rolled back: head untouched, suggestion still open.
    expect((await store.getDocument(docSlug("splice")))?.docVersion).toBe(1);
    const [after] = await store.listSuggestions(docSlug("splice"));
    expect(after?.status).toBe("open");
  });

  it("bulk import skips the oversized file with a per-file reason and lands the rest", async () => {
    const store = freshStore("cap");
    const summary = await store.importDocuments(
      [
        { path: "notes/huge.md", markdown: OVERSIZED },
        { path: "notes/fine.md", markdown: "# Fine" },
      ],
      by,
    );
    expect(summary).toEqual({
      created: 1,
      updated: 0,
      failed: [{ path: "notes/huge.md", reason: "too-large" }],
    });
    expect(
      (await store.getDocument(docSlug("notes-fine")))?.markdown,
    ).toContain("Fine");
  });
});

// The transport pre-filter the REST and MCP schemas reference. The WEB
// server fns intentionally do NOT use it — their validators keep plain
// z.string() and the handlers call markdownTooLarge instead, so an
// over-limit submission surfaces as a clean ValidationError rather than
// serialized Zod issues. Length-based: utf8Bytes(s) >= s.length, so
// exceeding it guarantees exceeding the byte cap — sound, but the
// multi-byte case above is why the DO stays authority.
describe("markdown byte cap — markdownBodyZ REST/MCP pre-filter", () => {
  it("rejects an over-length body with the shared message", () => {
    const r = markdownBodyZ.safeParse(OVERSIZED);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.message).toBe(MARKDOWN_TOO_LARGE_MESSAGE);
    }
  });

  it("accepts a body exactly at the cap", () => {
    expect(
      markdownBodyZ.safeParse("y".repeat(MAX_MARKDOWN_BYTES)).success,
    ).toBe(true);
  });
});

// — REST push (the CLI's write path) —————————————————————————————————

const MEMBER_SLUG = "member-doc";

// Mirrors cli-rest.test.ts's fixture: an api-key bound to a fresh
// Connection whose Collection contains one small seed document.
async function mintKey(): Promise<string> {
  const ownerUserId = await signUp("cap");
  const db = connectControlDb(env.DB);
  const ref = await createOrg(ownerUserId, "Org cap");
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

  const token = generateApiKeyToken();
  await db.insert(apiKey).values({
    userId: ownerUserId,
    organizationId: ref.organizationId,
    connectionId: conn.connectionId,
    name: "cap",
    tokenHash: await hashApiKeyToken(token),
    tokenPrefix: apiKeyDisplayPrefix(token),
  });
  return token;
}

function put(path: string, token: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://example.com${path}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("markdown byte cap — REST push (/api/v1/docs)", () => {
  it("413s an oversized push with a message naming the limit", async () => {
    const token = await mintKey();
    const r = await put(`/api/v1/docs/${MEMBER_SLUG}`, token, {
      markdown: OVERSIZED,
      clientVersion: 1,
    });
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: MARKDOWN_TOO_LARGE_MESSAGE });
  });

  it("413s a multi-byte push that passes the length gate (DO byte authority)", async () => {
    const token = await mintKey();
    const r = await put(`/api/v1/docs/${MEMBER_SLUG}`, token, {
      markdown: MULTIBYTE_OVERSIZED,
      clientVersion: 1,
    });
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: MARKDOWN_TOO_LARGE_MESSAGE });
  });
});

// — MCP suggest_edit ————————————————————————————————————————————————

type RpcResponse = Readonly<{
  error?: { code: number; message: string };
}>;

async function mcpSetup(): Promise<ReturnType<typeof scopedExecutor>> {
  const store = freshStore("capmcp");
  await store.saveDocument({
    slug: docSlug("doc-a"),
    markdown: "alpha one\n\nbeta two",
    clientVersion: 0,
    changedBy: "alice",
  });
  await store.createCollection({
    slug: colSlug("col-a"),
    name: "A",
    changedBy: "alice",
  });
  await store.attachDocument(colSlug("col-a"), docSlug("doc-a"), 1, "alice");
  const members = (await store.collectionMembers(colSlug("col-a"))) ?? [];
  return scopedExecutor(
    store,
    colSlug("col-a"),
    members,
    asCallerRef("apikey:agent-cap"),
    { baseUrl: "http://localhost:8787", projectId: asProjectId("test-cap") },
  );
}

function callSuggestEdit(
  exec: ReturnType<typeof scopedExecutor>,
  args: Record<string, unknown>,
): Promise<RpcResponse> {
  return handleMcp(
    RpcSchema.parse({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "suggest_edit", arguments: args },
    }),
    exec,
  ) as Promise<RpcResponse>;
}

describe("markdown byte cap — MCP suggest_edit", () => {
  it("INVALID_PARAMS naming the limit for an oversized proposal", async () => {
    const exec = await mcpSetup();
    const res = await callSuggestEdit(exec, {
      slug: "doc-a",
      proposedMarkdown: OVERSIZED,
      baseDocVersion: 1,
    });
    expect(res.error?.code).toBe(ERR.INVALID_PARAMS);
    expect(res.error?.message).toBe(MARKDOWN_TOO_LARGE_MESSAGE);
  });

  it("the DO byte authority refuses a multi-byte proposal the length gate passes", async () => {
    const exec = await mcpSetup();
    const res = await callSuggestEdit(exec, {
      slug: "doc-a",
      proposedMarkdown: MULTIBYTE_OVERSIZED,
      baseDocVersion: 1,
    });
    expect(res.error?.code).toBe(ERR.INVALID_PARAMS);
    expect(res.error?.message).toBe(MARKDOWN_TOO_LARGE_MESSAGE);
  });

  it("an oversized NEW-document proposal (baseDocVersion 0) is refused too", async () => {
    const exec = await mcpSetup();
    const res = await callSuggestEdit(exec, {
      slug: "fresh-doc",
      proposedMarkdown: MULTIBYTE_OVERSIZED,
      baseDocVersion: 0,
    });
    expect(res.error?.code).toBe(ERR.INVALID_PARAMS);
    expect(res.error?.message).toBe(MARKDOWN_TOO_LARGE_MESSAGE);
  });
});
