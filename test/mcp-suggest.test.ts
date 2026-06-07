import { describe, expect, it } from "vitest";

import { asCallerRef } from "../src/ids";
import { handleMcp, RpcSchema } from "../src/mcp";
import { ERR } from "../src/mcp/protocol";
import { scopedExecutor } from "../src/scoped-executor";

import { colSlug, docSlug, freshStore } from "./_helpers";

// suggest_edit is the first MCP write tool. These tests drive it the way
// respondMcp does in production (api.ts): a scopedExecutor bound to one
// Collection, with that Collection's members + a per-request callerRef,
// fed JSON-RPC tools/call envelopes through handleMcp. The load-bearing
// assertion is the membership gate — an agent cannot write a suggestion
// against a document outside its bound Collection.

const DOC_A = "alpha one\n\nbeta two";
const DOC_B = "gamma one\n\ndelta two";
const AGENT = asCallerRef("apikey:agent-a");

type RpcResponse = Readonly<{
  result?: { content?: { text: string }[] };
  error?: { code: number; message: string; data?: { currentVersion?: number } };
}>;

// Store with two Collections (A→doc-a, B→doc-b); the returned executor is
// bound to A only. B exists solely as the cross-tenant target.
async function setup(): Promise<{
  store: ReturnType<typeof freshStore>;
  exec: ReturnType<typeof scopedExecutor>;
}> {
  const store = freshStore("mcpsug");
  await store.saveDocument({
    slug: docSlug("doc-a"),
    markdown: DOC_A,
    clientVersion: 0,
    changedBy: "alice",
  });
  await store.createCollection({
    slug: colSlug("col-a"),
    name: "A",
    changedBy: "alice",
  });
  await store.attachDocument(colSlug("col-a"), docSlug("doc-a"), 1, "alice");

  await store.saveDocument({
    slug: docSlug("doc-b"),
    markdown: DOC_B,
    clientVersion: 0,
    changedBy: "bob",
  });
  await store.createCollection({
    slug: colSlug("col-b"),
    name: "B",
    changedBy: "bob",
  });
  await store.attachDocument(colSlug("col-b"), docSlug("doc-b"), 1, "bob");

  const members = (await store.collectionMembers(colSlug("col-a"))) ?? [];
  const exec = scopedExecutor(store, colSlug("col-a"), members, AGENT);
  return { store, exec };
}

function call(
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

function resultJson(res: RpcResponse): Record<string, unknown> {
  const text = res.result?.content?.[0]?.text;
  if (text === undefined) {
    throw new Error(`expected a result, got ${JSON.stringify(res)}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

describe("suggest_edit MCP tool (DO + D1 integration)", () => {
  it("agent proposes an edit in its bound Collection → suggestion stored, authored by the callerRef", async () => {
    const { store, exec } = await setup();
    const res = await call(exec, {
      slug: "doc-a",
      proposedMarkdown: `${DOC_A}\n\nepsilon three`,
      baseDocVersion: 1,
    });
    const json = resultJson(res);
    expect(json).toMatchObject({ hunkCount: 1 });
    expect(typeof json.suggestionId).toBe("number");

    const list = await store.listSuggestions(docSlug("doc-a"));
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe("open");
    // Provenance: authored by the agent's callerRef, and the transport is
    // recorded as `mcp` at write time (not inferred from the credential).
    expect(list[0]?.createdBy).toBe("apikey:agent-a");
    expect(list[0]?.channel).toBe("mcp");
  });

  it("CRITICAL: an agent bound to Collection A cannot suggest against a doc in Collection B", async () => {
    const { store, exec } = await setup();
    const res = await call(exec, {
      slug: "doc-b",
      proposedMarkdown: `${DOC_B}\n\nintruder`,
      baseDocVersion: 1,
    });
    // Same shape as a truly unknown document — no existence oracle.
    expect(res.error?.code).toBe(ERR.NOT_FOUND);
    // And, the load-bearing invariant: zero rows written outside the scope.
    expect(await store.listSuggestions(docSlug("doc-b"))).toHaveLength(0);
  });

  it("stale baseDocVersion → CONFLICT carrying the current head version", async () => {
    const { store, exec } = await setup();
    const res = await call(exec, {
      slug: "doc-a",
      proposedMarkdown: "totally rewritten",
      baseDocVersion: 0,
    });
    expect(res.error?.code).toBe(ERR.CONFLICT);
    expect(res.error?.data?.currentVersion).toBe(1);
    // A conflicted proposal writes nothing.
    expect(await store.listSuggestions(docSlug("doc-a"))).toHaveLength(0);
  });

  it("identical markdown → no-op success, no suggestion row", async () => {
    const { store, exec } = await setup();
    const res = await call(exec, {
      slug: "doc-a",
      proposedMarkdown: DOC_A,
      baseDocVersion: 1,
    });
    expect(resultJson(res)).toMatchObject({ hunkCount: 0, note: "no changes" });
    expect(await store.listSuggestions(docSlug("doc-a"))).toHaveLength(0);
  });

  it("unknown slug (not a member) → NOT_FOUND, nothing written", async () => {
    const { store, exec } = await setup();
    const res = await call(exec, {
      slug: "ghost",
      proposedMarkdown: "x",
      baseDocVersion: 1,
    });
    expect(res.error?.code).toBe(ERR.NOT_FOUND);
    expect(await store.listSuggestions(docSlug("ghost"))).toHaveLength(0);
  });

  it("missing proposedMarkdown → INVALID_PARAMS", async () => {
    const { exec } = await setup();
    const res = await call(exec, { slug: "doc-a", baseDocVersion: 1 });
    expect(res.error?.code).toBe(ERR.INVALID_PARAMS);
  });

  it("non-numeric baseDocVersion → INVALID_PARAMS", async () => {
    const { exec } = await setup();
    const res = await call(exec, {
      slug: "doc-a",
      proposedMarkdown: "x",
      baseDocVersion: "nope",
    });
    expect(res.error?.code).toBe(ERR.INVALID_PARAMS);
  });

  it("suggest_edit is advertised in tools/list with a real input schema", async () => {
    const { exec } = await setup();
    const res = (await handleMcp(
      RpcSchema.parse({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      exec,
    )) as {
      result: {
        tools: { name: string; inputSchema?: { required?: string[] } }[];
      };
    };
    const tool = res.result.tools.find((t) => t.name === "suggest_edit");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema?.required).toEqual([
      "proposedMarkdown",
      "baseDocVersion",
    ]);
  });
});
