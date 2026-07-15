import { describe, expect, it } from "vitest";

import {
  asCallerRef,
  asConnectionId,
  asUserId,
  callerRefFromOAuth,
} from "../src/ids";
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
  name = "suggest_edit",
): Promise<RpcResponse> {
  return handleMcp(
    RpcSchema.parse({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
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

  it("returns only the originating caller's durable open and partial-apply outcomes", async () => {
    const { store, exec } = await setup();
    const proposed = await call(exec, {
      slug: "doc-a",
      proposedMarkdown: "alpha changed\n\nbeta two\n\ngamma added",
      baseDocVersion: 1,
    });
    const proposalId = resultJson(proposed).suggestionId;
    if (typeof proposalId !== "number") throw new Error("missing proposal id");

    expect(
      resultJson(await call(exec, { proposalId }, "get_proposal_result")),
    ).toEqual({
      found: true,
      proposalId,
      kind: "edit",
      documentSlug: "doc-a",
      baseDocVersion: 1,
      outcome: "open",
      acceptedHunks: [],
    });

    const suggestion = (await store.listSuggestions(docSlug("doc-a")))[0];
    if (suggestion === undefined || suggestion.hunks.length < 2) {
      throw new Error("expected a multi-hunk proposal");
    }
    for (const [index, hunk] of suggestion.hunks.entries()) {
      await store.setHunkDecision({
        hunkId: hunk.id,
        decision: index === 0 ? "accepted" : "rejected",
      });
    }
    expect(
      resultJson(await call(exec, { proposalId }, "get_proposal_result")),
    ).toMatchObject({ outcome: "open", acceptedHunks: [] });
    expect(
      await store.applySuggestion({
        suggestionId: proposalId,
        appliedBy: "alice",
        reviewerNote: "Kept the focused part; the rest is too broad.",
      }),
    ).toMatchObject({ ok: true, docVersion: 2 });

    expect(
      resultJson(await call(exec, { proposalId }, "get_proposal_result")),
    ).toMatchObject({
      outcome: "partially_applied",
      resultingDocVersion: 2,
      reviewerNote: "Kept the focused part; the rest is too broad.",
      acceptedHunks: [{ decision: "accepted" }],
    });

    const other = scopedExecutor(
      store,
      colSlug("col-a"),
      (await store.collectionMembers(colSlug("col-a"))) ?? [],
      asCallerRef("apikey:agent-b"),
    );
    expect(
      (await call(other, { proposalId }, "get_proposal_result")).error,
    ).toMatchObject({ code: ERR.NOT_FOUND, message: "unknown proposal" });
  });

  it("keeps proposals private between OAuth Connections owned by the same user", async () => {
    const { store } = await setup();
    const members = (await store.collectionMembers(colSlug("col-a"))) ?? [];
    const userId = asUserId("same-user");
    const first = scopedExecutor(
      store,
      colSlug("col-a"),
      members,
      callerRefFromOAuth(userId, asConnectionId("conn-a")),
    );
    const second = scopedExecutor(
      store,
      colSlug("col-a"),
      members,
      callerRefFromOAuth(userId, asConnectionId("conn-b")),
    );
    const proposalId = resultJson(
      await call(first, {
        slug: "doc-a",
        proposedMarkdown: `${DOC_A}\n\nprivate to conn-a`,
        baseDocVersion: 1,
      }),
    ).suggestionId;
    if (typeof proposalId !== "number") throw new Error("missing proposal id");

    expect(
      (await call(second, { proposalId }, "get_proposal_result")).error,
    ).toMatchObject({ code: ERR.NOT_FOUND, message: "unknown proposal" });
  });

  it("reports a fully accepted edit as applied with the exact public result shape", async () => {
    const { store, exec } = await setup();
    const proposalId = resultJson(
      await call(exec, {
        slug: "doc-a",
        proposedMarkdown: `${DOC_A}\n\nfully accepted`,
        baseDocVersion: 1,
      }),
    ).suggestionId;
    if (typeof proposalId !== "number") throw new Error("missing proposal id");
    const hunk = (await store.listSuggestions(docSlug("doc-a")))[0]?.hunks[0];
    if (hunk === undefined) throw new Error("missing proposal hunk");
    await store.setHunkDecision({
      hunkId: hunk.id,
      decision: "accepted",
    });
    await store.applySuggestion({
      suggestionId: proposalId,
      appliedBy: "alice",
    });

    expect(
      resultJson(await call(exec, { proposalId }, "get_proposal_result")),
    ).toEqual({
      found: true,
      proposalId,
      kind: "edit",
      documentSlug: "doc-a",
      baseDocVersion: 1,
      outcome: "applied",
      resultingDocVersion: 2,
      resolvedAt: expect.any(String),
      acceptedHunks: [{ ...hunk, decision: "accepted" }],
    });
  });

  it("reports rejected and stale terminal outcomes", async () => {
    const { store, exec } = await setup();
    const rejectedId = resultJson(
      await call(exec, {
        slug: "doc-a",
        proposedMarkdown: `${DOC_A}\n\nrejected addition`,
        baseDocVersion: 1,
      }),
    ).suggestionId;
    const staleId = resultJson(
      await call(exec, {
        slug: "doc-a",
        proposedMarkdown: `${DOC_A}\n\nstale addition`,
        baseDocVersion: 1,
      }),
    ).suggestionId;
    if (typeof rejectedId !== "number" || typeof staleId !== "number") {
      throw new Error("missing proposal ids");
    }
    await store.rejectSuggestion({
      suggestionId: rejectedId,
      rejectedBy: "alice",
      reviewerNote: "Not aligned with the collection.",
    });
    const staleHunk = (await store.listSuggestions(docSlug("doc-a")))
      .find((suggestion) => suggestion.id === staleId)
      ?.hunks.at(0);
    if (staleHunk === undefined) throw new Error("missing stale hunk");
    await store.setHunkDecision({
      hunkId: staleHunk.id,
      decision: "accepted",
    });
    await store.saveDocument({
      slug: docSlug("doc-a"),
      markdown: `${DOC_A}\n\nnew canonical head`,
      clientVersion: 1,
      changedBy: "alice",
    });
    await store.applySuggestion({ suggestionId: staleId, appliedBy: "alice" });

    expect(
      resultJson(
        await call(exec, { proposalId: rejectedId }, "get_proposal_result"),
      ),
    ).toMatchObject({
      outcome: "rejected",
      reviewerNote: "Not aligned with the collection.",
    });
    expect(
      resultJson(
        await call(exec, { proposalId: staleId }, "get_proposal_result"),
      ),
    ).toMatchObject({ outcome: "stale" });
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

  it("baseDocVersion 0 with a fresh slug files a NEW-document proposal", async () => {
    const { store, exec } = await setup();
    const res = await call(exec, {
      slug: "brand-new",
      proposedMarkdown: "# Brand New\n\nbody",
      baseDocVersion: 0,
    });
    const json = resultJson(res);
    expect(json).toMatchObject({ created: true, slug: "brand-new" });
    expect(typeof json.suggestionId).toBe("number");

    const proposals = await store.listCreateProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      slug: "brand-new",
      title: "Brand New",
      channel: "mcp",
      createdBy: "apikey:agent-a",
    });
    // Nothing was created — the proposal is review state, not a document.
    expect(await store.getDocument(docSlug("brand-new"))).toBeUndefined();

    const proposalId = json.suggestionId;
    if (typeof proposalId !== "number") throw new Error("missing proposal id");
    expect(
      await store.applyCreateProposal({
        suggestionId: proposalId,
        appliedBy: "alice",
        reviewerNote: "Useful addition.",
      }),
    ).toMatchObject({ ok: true, docVersion: 1 });
    expect(
      resultJson(await call(exec, { proposalId }, "get_proposal_result")),
    ).toMatchObject({
      kind: "create",
      outcome: "applied",
      resultingDocVersion: 1,
      reviewerNote: "Useful addition.",
    });
  });

  it("baseDocVersion 0 with a fresh Corpus path derives the slug like the import path", async () => {
    const { store, exec } = await setup();
    const res = await call(exec, {
      path: "wiki/answer-x.md",
      proposedMarkdown: "answer body",
      baseDocVersion: 0,
    });
    expect(resultJson(res)).toMatchObject({
      created: true,
      slug: "wiki-answer-x",
    });
    const proposals = await store.listCreateProposals();
    expect(proposals[0]?.path).toBe("wiki/answer-x.md");
  });

  it("CRITICAL: baseDocVersion 0 against a slug that exists OUTSIDE the bound Collection writes nothing", async () => {
    const { store, exec } = await setup();
    const res = await call(exec, {
      slug: "doc-b",
      proposedMarkdown: "intruder create",
      baseDocVersion: 0,
    });
    // Same existence grade the REST create path exposes via its 403: the
    // identifier is unavailable, and no proposal row is written.
    expect(res.error?.code).toBe(ERR.CONFLICT);
    expect(await store.listCreateProposals()).toHaveLength(0);
    expect(await store.listSuggestions(docSlug("doc-b"))).toHaveLength(0);
  });

  it("baseDocVersion 0 with a malformed slug → INVALID_PARAMS", async () => {
    const { store, exec } = await setup();
    const res = await call(exec, {
      slug: "Not A Slug!",
      proposedMarkdown: "x",
      baseDocVersion: 0,
    });
    expect(res.error?.code).toBe(ERR.INVALID_PARAMS);
    expect(await store.listCreateProposals()).toHaveLength(0);
  });

  it("baseDocVersion 0 with empty proposedMarkdown → INVALID_PARAMS", async () => {
    const { store, exec } = await setup();
    const res = await call(exec, {
      slug: "brand-new",
      proposedMarkdown: "  \n",
      baseDocVersion: 0,
    });
    expect(res.error?.code).toBe(ERR.INVALID_PARAMS);
    expect(await store.listCreateProposals()).toHaveLength(0);
  });

  it("suggest_edit is advertised in tools/list with a real input schema", async () => {
    const { exec } = await setup();
    const res = (await handleMcp(
      RpcSchema.parse({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      exec,
    )) as {
      result: {
        tools: {
          name: string;
          inputSchema?: {
            required?: string[];
            properties?: Record<string, Record<string, unknown>>;
          };
        }[];
      };
    };
    const tool = res.result.tools.find((t) => t.name === "suggest_edit");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema?.required).toEqual([
      "proposedMarkdown",
      "baseDocVersion",
    ]);
    expect(tool?.inputSchema?.properties?.baseDocVersion).toMatchObject({
      type: "integer",
      minimum: 0,
    });
    const resultTool = res.result.tools.find(
      (candidate) => candidate.name === "get_proposal_result",
    );
    expect(resultTool?.inputSchema?.properties?.proposalId).toMatchObject({
      type: "integer",
      minimum: 1,
    });
  });
});
