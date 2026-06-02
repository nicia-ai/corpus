import { describe, expect, it } from "vitest";

import {
  EXAMPLE_GRAPH,
  layout,
  linkageSentences,
  type GraphInput,
} from "../src/components/project-graph/layout";

// Single source of truth for the example shape (the empty-state graph):
// refund-policy in BOTH collections, product + brand-voice in Sales
// only, collections read by concrete agents.
const SEED: GraphInput = EXAMPLE_GRAPH;

describe("layout (pure, deterministic)", () => {
  it("same input twice produces byte-identical output", () => {
    expect(layout(SEED)).toEqual(layout(SEED));
  });

  it("input order does not affect output (slug-sorted)", () => {
    const reordered: GraphInput = {
      documents: [...SEED.documents].reverse(),
      collections: [...SEED.collections].reverse(),
      attachments: [...SEED.attachments].reverse(),
      agents: [...(SEED.agents ?? [])].reverse(),
      agentLinks: [...(SEED.agentLinks ?? [])].reverse(),
    };
    expect(layout(reordered)).toEqual(layout(SEED));
  });

  it("empty project is flagged empty with no nodes", () => {
    const l = layout({ documents: [], collections: [], attachments: [] });
    expect(l.empty).toBe(true);
    expect(l.nodes).toHaveLength(0);
    expect(l.edges).toHaveLength(0);
  });

  it("the shared document is ONE node feeding both collections", () => {
    const l = layout(SEED);
    const refund = l.nodes.find((n) => n.id === "document:refund-policy");
    expect(refund?.collectionCount).toBe(2);
    const fromRefund = l.edges.filter(
      (e) => e.fromId === "document:refund-policy",
    );
    expect(fromRefund.map((e) => e.toId).sort()).toEqual([
      "collection:sales-agent",
      "collection:support-agent",
    ]);
  });

  it("brand-voice feeds Sales only — present, not stranded", () => {
    const l = layout(SEED);
    const brand = l.nodes.find((n) => n.id === "document:brand-voice");
    expect(brand?.collectionCount).toBe(1);
    const fromBrand = l.edges.filter(
      (e) => e.fromId === "document:brand-voice",
    );
    expect(fromBrand.map((e) => e.toId)).toEqual(["collection:sales-agent"]);
  });

  it("product feeds Sales only — present, not stranded", () => {
    const l = layout(SEED);
    const product = l.nodes.find((n) => n.id === "document:product");
    expect(product?.collectionCount).toBe(1);
    const fromProduct = l.edges.filter((e) => e.fromId === "document:product");
    expect(fromProduct.map((e) => e.toId)).toEqual(["collection:sales-agent"]);
  });

  it("the example expands collections into concrete agent nodes", () => {
    const l = layout(SEED);
    expect(
      l.nodes
        .filter((n) => n.kind === "agent")
        .map((n) => n.id)
        .sort(),
    ).toEqual([
      "agent:cold-outbound-agent",
      "agent:customer-support-bot",
      "agent:sales-assistant",
    ]);
    const toAgents = l.edges
      .filter((e) => e.toId.startsWith("agent:"))
      .map((e) => `${e.fromId}>${e.toId}`)
      .sort();
    expect(toAgents).toEqual([
      "collection:sales-agent>agent:cold-outbound-agent",
      "collection:sales-agent>agent:sales-assistant",
      "collection:support-agent>agent:customer-support-bot",
    ]);
  });

  it("no agent nodes without agents input (no col-2 fallback)", () => {
    const l = layout({
      documents: [{ slug: "a", title: "A" }],
      collections: [{ slug: "c", name: "C" }],
      attachments: [],
    });
    expect(l.nodes.every((n) => n.kind !== "agent")).toBe(true);
    expect(l.nodes.map((n) => n.kind).sort()).toEqual([
      "collection",
      "document",
    ]);
  });

  it("doc → collection edges preserve attachment position", () => {
    const l = layout({
      documents: [
        { slug: "a", title: "A" },
        { slug: "b", title: "B" },
      ],
      collections: [{ slug: "c", name: "C" }],
      attachments: [
        { collectionSlug: "c", documentSlug: "b", position: 2 },
        { collectionSlug: "c", documentSlug: "a", position: 1 },
      ],
    });
    const edges = l.edges
      .filter((e) => e.toId === "collection:c")
      .map((e) => ({ from: e.fromId, position: e.position }));
    expect(edges).toEqual([
      { from: "document:a", position: 1 },
      { from: "document:b", position: 2 },
    ]);
  });

  it("columns: documents 0, collections 1, agents 2", () => {
    const l = layout(SEED);
    expect(l.nodes.find((n) => n.kind === "document")?.col).toBe(0);
    expect(l.nodes.find((n) => n.kind === "collection")?.col).toBe(1);
    expect(l.nodes.find((n) => n.kind === "agent")?.col).toBe(2);
  });
});

describe("linkageSentences (screen-reader source of truth)", () => {
  it("states which collections each document feeds", () => {
    const s = linkageSentences(SEED);
    expect(s).toEqual([
      {
        documentSlug: "brand-voice",
        sentence: "Brand Voice — used by Sales",
      },
      {
        documentSlug: "product",
        sentence: "Product — used by Sales",
      },
      {
        documentSlug: "refund-policy",
        sentence: "Refund Policy — used by Sales, Support",
      },
    ]);
  });
});
