import { describe, expect, it } from "vitest";

import { asCallerRef, asProjectId } from "../src/ids";
import { handleMcp, type McpExecutor } from "../src/mcp";
import {
  DEFAULT_ALWAYS_INCLUDE_BUDGET_TOKENS,
  MAX_ALWAYS_INCLUDE_BUDGET_TOKENS,
} from "../src/util";

import { colSlug, docSlug, freshStore } from "./_helpers";

const ws = () => freshStore("col");

describe("collection assembly (data plane)", () => {
  it("assembles a collection in position order with provenance + size", async () => {
    const w = ws();
    for (const s of ["alpha", "bravo", "charlie"]) {
      await w.saveDocument({
        slug: docSlug(s),
        markdown: `# ${s}\nbody of ${s}`,
        clientVersion: 0,
        changedBy: "u",
      });
    }
    await w.createCollection({
      slug: colSlug("support"),
      name: "Support Agent",
      changedBy: "u",
    });
    // Attach out of order; position must drive assembly, not insert order.
    await w.attachDocument(colSlug("support"), docSlug("bravo"), 2, "u");
    await w.attachDocument(colSlug("support"), docSlug("alpha"), 1, "u");
    await w.attachDocument(colSlug("support"), docSlug("charlie"), 3, "u");

    const r = await w.readCollection(colSlug("support"));
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.documents.map((d) => d.slug)).toEqual([
      "alpha",
      "bravo",
      "charlie",
    ]);
    expect(r.documents[0]?.size).toBeGreaterThan(0);
    // Body order follows position.
    const ia = r.corpus.indexOf("body of alpha");
    const ib = r.corpus.indexOf("body of bravo");
    const ic = r.corpus.indexOf("body of charlie");
    expect(ia).toBeGreaterThan(-1);
    expect(ia).toBeLessThan(ib);
    expect(ib).toBeLessThan(ic);
    expect(r.corpus).toContain("# Collection: support");
  });

  it("unknown collection → found:false; empty collection → sentinel", async () => {
    const w = ws();
    expect(await w.readCollection(colSlug("nope"))).toEqual({ found: false });
    await w.createCollection({
      slug: colSlug("empty"),
      name: "Empty",
      changedBy: "u",
    });
    const r = await w.readCollection(colSlug("empty"));
    expect(r.found).toBe(true);
    if (r.found) {
      expect(r.documents).toEqual([]);
      expect(r.corpus).toContain("(no documents in this collection)");
    }
  });
});

describe("collection mutations append to the change-event ledger (P1)", () => {
  it("createCollection writes a collection.created event", async () => {
    const w = ws();
    await w.createCollection({
      slug: colSlug("alerts"),
      name: "Alerts",
      changedBy: "alice",
    });
    const [latest] = await w.recentChanges(1);
    expect(latest).toMatchObject({
      eventType: "collection.created",
      documentSlug: null,
      changedBy: "alice",
    });
  });

  it("idempotent createCollection emits no second event", async () => {
    const w = ws();
    await w.createCollection({
      slug: colSlug("dup"),
      name: "Dup",
      changedBy: "u",
    });
    const afterFirst = await w.lastEventId();
    await w.createCollection({
      slug: colSlug("dup"),
      name: "Dup",
      changedBy: "u",
    });
    expect(await w.lastEventId()).toBe(afterFirst);
  });

  it("attach emits collection.attached, re-position emits collection.reordered", async () => {
    const w = ws();
    await w.saveDocument({
      slug: docSlug("runbook"),
      markdown: "# runbook",
      clientVersion: 0,
      changedBy: "u",
    });
    await w.createCollection({
      slug: colSlug("ops"),
      name: "Ops",
      changedBy: "u",
    });

    expect(
      (await w.attachDocument(colSlug("ops"), docSlug("runbook"), 1, "bob")).ok,
    ).toBe(true);
    const [attached] = await w.recentChanges(1);
    expect(attached).toMatchObject({
      eventType: "collection.attached",
      documentSlug: "runbook",
      changedBy: "bob",
    });

    // Same (collection, document) edge again → reorder, not a second attach.
    await w.attachDocument(colSlug("ops"), docSlug("runbook"), 5, "bob");
    const [reordered] = await w.recentChanges(1);
    expect(reordered?.eventType).toBe("collection.reordered");
  });

  it("detach removes the document and emits collection.detached", async () => {
    const w = ws();
    for (const s of ["a", "b"]) {
      await w.saveDocument({
        slug: docSlug(s),
        markdown: `# ${s}`,
        clientVersion: 0,
        changedBy: "u",
      });
    }
    await w.createCollection({
      slug: colSlug("ops"),
      name: "Ops",
      changedBy: "u",
    });
    await w.attachDocument(colSlug("ops"), docSlug("a"), 1, "u");
    await w.attachDocument(colSlug("ops"), docSlug("b"), 2, "u");

    expect(
      (await w.detachDocument(colSlug("ops"), docSlug("a"), "bob")).ok,
    ).toBe(true);
    const [evt] = await w.recentChanges(1);
    expect(evt).toMatchObject({
      eventType: "collection.detached",
      documentSlug: "a",
      changedBy: "bob",
    });
    const r = await w.readCollection(colSlug("ops"));
    if (!r.found) throw new Error("collection vanished");
    expect(r.documents.map((d) => d.slug)).toEqual(["b"]);
  });

  it("detach of an unattached document is a no-op", async () => {
    const w = ws();
    await w.createCollection({
      slug: colSlug("ops"),
      name: "Ops",
      changedBy: "u",
    });
    const before = await w.lastEventId();
    expect(
      (await w.detachDocument(colSlug("ops"), docSlug("ghost"), "u")).ok,
    ).toBe(false);
    expect(await w.lastEventId()).toBe(before);
  });

  it("reorder sets a new order and emits collection.reordered", async () => {
    const w = ws();
    for (const s of ["a", "b", "c"]) {
      await w.saveDocument({
        slug: docSlug(s),
        markdown: `# ${s}`,
        clientVersion: 0,
        changedBy: "u",
      });
      await w.createCollection({
        slug: colSlug("ops"),
        name: "Ops",
        changedBy: "u",
      });
      await w.attachDocument(
        colSlug("ops"),
        docSlug(s),
        ["a", "b", "c"].indexOf(s) + 1,
        "u",
      );
    }

    expect(
      (
        await w.reorderCollectionDocuments(
          colSlug("ops"),
          [docSlug("c"), docSlug("a"), docSlug("b")],
          "bob",
        )
      ).ok,
    ).toBe(true);
    const [evt] = await w.recentChanges(1);
    expect(evt?.eventType).toBe("collection.reordered");
    const r = await w.readCollection(colSlug("ops"));
    if (!r.found) throw new Error("collection vanished");
    expect(r.documents.map((d) => d.slug)).toEqual(["c", "a", "b"]);
  });

  it("attach to a missing collection emits nothing", async () => {
    const w = ws();
    expect(
      (await w.attachDocument(colSlug("ghost"), docSlug("nope"), 0, "u")).ok,
    ).toBe(false);
    expect(await w.lastEventId()).toBe(0);
  });
});

describe("MCP JSON-RPC dispatcher", () => {
  const fake: McpExecutor = {
    callerRef: asCallerRef("apikey:test"),
    baseUrl: "http://localhost:8787",
    projectId: asProjectId("test-project"),
    recordRead: () => Promise.resolve(),
    suggestEdit: () =>
      Promise.resolve({ ok: false as const, reason: "missing" as const }),
    suggestCreate: () =>
      Promise.resolve({ ok: false as const, reason: "invalid" as const }),
    proposalResult: () => Promise.resolve({ found: false as const }),
    replyToProposal: () =>
      Promise.resolve({ ok: false as const, reason: "missing" as const }),
    listCollections: async () => [{ slug: "c1", name: "C1" }],
    listDocuments: async () => [
      { slug: "d1", title: "D1", docVersion: 1, size: 3, path: "docs/d1.md" },
      { slug: "d2", title: "D2", docVersion: 1, size: 5, path: "docs/d2.md" },
    ],
    readCollection: async (s) => {
      if (s === "c1")
        return {
          found: true,
          corpus: "CORPUS",
          documents: [{ slug: "d1", docVersion: 1, size: 3 }],
        };
      if (s === "big")
        return {
          found: true,
          corpus: "BIGCORPUS",
          documents: [{ slug: "d1", docVersion: 1, size: 9000 }],
        };
      return { found: false };
    },
    collectionMembers: async (s) =>
      s === "c1" || s === "big" ? ["d1"] : undefined,
    getDocument: async (s) => {
      if (s === "d1")
        return { slug: "d1", title: "D1", markdown: "MD", docVersion: 1 };
      if (s === "d2")
        return { slug: "d2", title: "D2", markdown: "MD2", docVersion: 1 };
      return undefined;
    },
    verifyHistory: async () => ({ ok: true }),
    collectionOutline: async (s) =>
      s === "c1"
        ? {
            found: true,
            collection: "c1",
            name: "C1",
            documents: [
              {
                slug: "d1",
                path: "docs/d1.md",
                title: "D1",
                docVersion: 1,
                delivery: "core",
                links: [],
              },
              {
                slug: "d2",
                path: "docs/d2.md",
                title: "D2",
                docVersion: 1,
                delivery: "reference",
                links: [],
              },
            ],
          }
        : { found: false },
  };

  it("initialize advertises tools + resources", async () => {
    const r = (await handleMcp(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      fake,
    )) as { result: { capabilities: Record<string, unknown> } };
    expect(r.result.capabilities).toHaveProperty("tools");
    expect(r.result.capabilities).toHaveProperty("resources");
  });

  it("tools/list returns the read tools and proposal workflow tools", async () => {
    const r = (await handleMcp(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      fake,
    )) as { result: { tools: { name: string }[] } };
    expect(r.result.tools.map((t) => t.name).sort()).toEqual([
      "await_proposal_review",
      "get_proposal_result",
      "list_collections",
      "list_documents",
      "read_collection",
      "read_document",
      "read_document_meta",
      "reply_to_proposal",
      "suggest_edit",
      "verify_history",
    ]);
  });

  it("verify_history dispatches to the executor", async () => {
    const r = (await handleMcp(
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "verify_history", arguments: {} },
      },
      fake,
    )) as { result: { content: { text: string }[] } };
    expect(JSON.parse(r.result.content[0]?.text ?? "")).toEqual({ ok: true });
  });

  it("read_collection unknown → JSON-RPC error", async () => {
    const r = (await handleMcp(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "read_collection", arguments: { collectionSlug: "x" } },
      },
      fake,
    )) as { error?: { code: number } };
    expect(r.error?.code).toBe(-32004);
  });

  const callTool = (name: string, args: Record<string, unknown>) =>
    handleMcp(
      {
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: { name, arguments: args },
      },
      fake,
    ) as Promise<{
      result?: { content: { text: string }[] };
      error?: { code: number };
    }>;

  it("read_collection within budget → assembled corpus", async () => {
    const r = await callTool("read_collection", { collectionSlug: "c1" });
    expect(r.result?.content[0]?.text).toBe("CORPUS");
  });

  it("read_collection defaults to the bound collection", async () => {
    const r = await callTool("read_collection", {});
    expect(r.result?.content[0]?.text).toBe("CORPUS");
  });

  it("read_collection always assembles and ships the full corpus (no MCP-side budget enforcement)", async () => {
    // The per-collection alwaysIncludeBudgetTokens is authoring-side
    // guidance only; MCP never substitutes a directive — owners get the
    // assembled corpus they configured, oversized or not.
    const r = await callTool("read_collection", { collectionSlug: "big" });
    expect(r.result?.content[0]?.text).toBe("BIGCORPUS");
  });

  it("read_collection returns Core docs while Reference docs stay readable", async () => {
    const w = freshStore("col-delivery");
    await w.saveDocument({
      slug: docSlug("brand"),
      markdown: "# Brand",
      clientVersion: 0,
      changedBy: "u",
    });
    await w.saveDocument({
      slug: docSlug("features"),
      markdown: "# Features",
      clientVersion: 0,
      changedBy: "u",
    });
    await w.createCollection({
      slug: colSlug("sales"),
      name: "Sales",
      changedBy: "u",
    });
    await w.attachDocument(colSlug("sales"), docSlug("brand"), 1, "u", "core");
    await w.attachDocument(
      colSlug("sales"),
      docSlug("features"),
      2,
      "u",
      "reference",
    );

    const r = await w.readCollection(colSlug("sales"));
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.documents.map((d) => d.slug)).toEqual(["brand"]);
    expect(r.corpus).toContain("reference document");

    const outline = await w.collectionOutline(colSlug("sales"));
    expect(outline.found).toBe(true);
    if (!outline.found) return;
    expect(outline.documents.map((d) => [d.slug, d.delivery])).toEqual([
      ["brand", "core"],
      ["features", "reference"],
    ]);
  });

  // C3: list_documents/read_document take no collectionSlug arg — the
  // bound Collection is the scope and the scopedExecutor wrapper does
  // the filtering. handleMcp simply delegates to the executor, so its
  // job here is to pass through the executor's data unchanged.
  it("list_documents delegates to the executor unchanged", async () => {
    const r = await callTool("list_documents", {});
    const docs = JSON.parse(r.result?.content[0]?.text ?? "[]") as {
      slug: string;
    }[];
    expect(docs.map((d) => d.slug).sort()).toEqual(["d1", "d2"]);
  });

  it("read_document reads by slug; unknown → JSON-RPC error", async () => {
    const ok = await callTool("read_document", { slug: "d2" });
    expect(ok.result?.content[0]?.text).toBe("MD2");
    const miss = await callTool("read_document", { slug: "nope" });
    expect(miss.error?.code).toBe(-32004);
  });

  it("read_document reads by Corpus path", async () => {
    const ok = await callTool("read_document", { path: "./docs/d2.md" });
    expect(ok.result?.content[0]?.text).toBe("MD2");
  });

  it("resources/list exposes collection:// and document:// uris", async () => {
    const r = (await handleMcp(
      { jsonrpc: "2.0", id: 4, method: "resources/list" },
      fake,
    )) as { result: { resources: { uri: string }[] } };
    const uris = r.result.resources.map((x) => x.uri);
    expect(uris).toContain("collection://c1");
    expect(uris).toContain("document://d1");
  });
});

// The per-collection authoring-side threshold (the BudgetMeter in the
// edit pane compares the assembled `delivery=core` set against it). The
// Zod bound lives on the Collection node schema (`src/graph.ts`); the
// server-fn input validator (`src/lib/server/collections.ts`) and the
// bundle schema (`src/store/domain/bundle.ts`) declare the same
// `.nonnegative().max(MAX_ALWAYS_INCLUDE_BUDGET_TOKENS)` cap, so the
// DO never sees an out-of-range value through any normal entry point.
// These tests pin the audit-trail / round-trip behaviour the bound
// supports.
describe("alwaysIncludeBudgetTokens — audit trail + round-trip", () => {
  it("createCollection without a budget seeds the default value", async () => {
    const w = freshStore("budget");
    await w.createCollection({
      slug: colSlug("default"),
      name: "Default",
      changedBy: "u",
    });
    const det = await w.collectionStructure(colSlug("default"));
    if (!det.found) throw new Error("collection vanished");
    expect(det.alwaysIncludeBudgetTokens).toBe(
      DEFAULT_ALWAYS_INCLUDE_BUDGET_TOKENS,
    );
  });

  it("updateCollection with a new budget persists it and emits before/after on the event", async () => {
    const w = freshStore("budget");
    await w.createCollection({
      slug: colSlug("growable"),
      name: "Growable",
      changedBy: "u",
    });

    expect(
      (
        await w.updateCollection({
          slug: colSlug("growable"),
          name: "Growable",
          alwaysIncludeBudgetTokens: 32_000,
          changedBy: "ivy",
        })
      ).ok,
    ).toBe(true);

    const det = await w.collectionStructure(colSlug("growable"));
    if (!det.found) throw new Error("collection vanished");
    expect(det.alwaysIncludeBudgetTokens).toBe(32_000);

    const [latest] = await w.recentChanges(1);
    expect(latest?.eventType).toBe("collection.updated");
    const before = JSON.parse(latest?.beforeJson ?? "{}") as {
      alwaysIncludeBudgetTokens?: number;
    };
    const after = JSON.parse(latest?.afterJson ?? "{}") as {
      alwaysIncludeBudgetTokens?: number;
    };
    expect(before.alwaysIncludeBudgetTokens).toBe(
      DEFAULT_ALWAYS_INCLUDE_BUDGET_TOKENS,
    );
    expect(after.alwaysIncludeBudgetTokens).toBe(32_000);
  });

  it("updateCollection without an explicit budget preserves the existing one", async () => {
    const w = freshStore("budget");
    await w.createCollection({
      slug: colSlug("preserve"),
      name: "Preserve",
      alwaysIncludeBudgetTokens: 50_000,
      changedBy: "u",
    });
    await w.updateCollection({
      slug: colSlug("preserve"),
      name: "Preserved",
      changedBy: "u",
    });
    const det = await w.collectionStructure(colSlug("preserve"));
    if (!det.found) throw new Error("collection vanished");
    expect(det.alwaysIncludeBudgetTokens).toBe(50_000);
  });

  it("at-the-cap value round-trips through the bundle unchanged", async () => {
    const w = freshStore("budget");
    await w.createCollection({
      slug: colSlug("max"),
      name: "Max",
      alwaysIncludeBudgetTokens: MAX_ALWAYS_INCLUDE_BUDGET_TOKENS,
      changedBy: "u",
    });
    const b = await w.exportBundle({ organization: "o", project: "p" });
    expect(b.collections["max"]?.alwaysIncludeBudgetTokens).toBe(
      MAX_ALWAYS_INCLUDE_BUDGET_TOKENS,
    );
  });
});
