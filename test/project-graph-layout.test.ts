import { describe, expect, it } from "vitest";

import {
  EXAMPLE_GRAPH,
  GRAPH_GEOMETRY,
  columnX,
  layout,
  linkageSentences,
  type GraphInput,
} from "../src/components/project-graph/layout";

// The canonical example: two corpora, three agents. The support bot reads
// both corpora; the cold-outbound agent and sales assistant read company only.
const SEED: GraphInput = EXAMPLE_GRAPH;

const EMPTY: GraphInput = { corpora: [], agents: [], agentLinks: [] };

const SINGLE_CORPUS: GraphInput = {
  corpora: [{ slug: "company", name: "Company" }],
  agents: [{ slug: "bot", name: "Bot" }],
  agentLinks: [{ corpusSlug: "company", agentSlug: "bot" }],
};

describe("layout (pure, deterministic)", () => {
  it("same input twice produces byte-identical output", () => {
    expect(layout(SEED)).toEqual(layout(SEED));
  });

  it("input order does not affect output (slug-sorted)", () => {
    const reordered: GraphInput = {
      corpora: [...SEED.corpora].reverse(),
      agents: [...SEED.agents].reverse(),
      agentLinks: [...SEED.agentLinks].reverse(),
    };
    expect(layout(reordered)).toEqual(layout(SEED));
  });

  it("empty project is flagged empty with no nodes, edges, or rows", () => {
    const l = layout(EMPTY);
    expect(l.empty).toBe(true);
    expect(l.nodes).toHaveLength(0);
    expect(l.edges).toHaveLength(0);
    expect(l.height).toBeGreaterThan(0);
  });

  it("one corpus fans out to every agent that reads it", () => {
    const l = layout(SEED);
    const fromCompany = l.edges
      .filter((e) => e.fromId === "corpus:company")
      .map((e) => e.toId)
      .sort();
    expect(fromCompany).toEqual([
      "agent:cold-outbound-agent",
      "agent:customer-support-bot",
      "agent:sales-assistant",
    ]);
  });

  it("an agent that reads two corpora connects to both", () => {
    const l = layout(SEED);
    const toSupportBot = l.edges
      .filter((e) => e.toId === "agent:customer-support-bot")
      .map((e) => e.fromId)
      .sort();
    expect(toSupportBot).toEqual(["corpus:company", "corpus:support-desk"]);
  });

  it("the example expands into concrete agent nodes", () => {
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
    expect(l.edges).toHaveLength(SEED.agentLinks.length);
  });

  it("drops a link whose agent is not declared (no dangling edge)", () => {
    const l = layout({
      ...SINGLE_CORPUS,
      agentLinks: [
        { corpusSlug: "company", agentSlug: "bot" },
        { corpusSlug: "company", agentSlug: "ghost" },
      ],
    });
    expect(l.edges.map((e) => e.toId)).toEqual(["agent:bot"]);
  });

  it("columns: corpora 0, agents 1", () => {
    const l = layout(SEED);
    const corpusNodes = l.nodes.filter((n) => n.kind === "corpus");
    const agentNodes = l.nodes.filter((n) => n.kind === "agent");
    expect(corpusNodes.length).toBeGreaterThan(0);
    expect(agentNodes.length).toBeGreaterThan(0);
    expect(corpusNodes.every((n) => n.col === 0 && n.x === columnX(0))).toBe(
      true,
    );
    expect(agentNodes.every((n) => n.col === 1 && n.x === columnX(1))).toBe(
      true,
    );
  });

  it("edges run from a corpus's right edge to an agent's left edge", () => {
    const l = layout(SINGLE_CORPUS);
    const [edge] = l.edges;
    const corpus = l.nodes.find((n) => n.id === "corpus:company");
    const agent = l.nodes.find((n) => n.id === "agent:bot");
    expect(edge).toBeDefined();
    expect(corpus).toBeDefined();
    expect(agent).toBeDefined();
    expect(edge?.x1).toBe(GRAPH_GEOMETRY.PAD + GRAPH_GEOMETRY.NODE_W);
    expect(edge?.x2).toBe(agent?.x);
    expect(edge?.y1).toBe((corpus?.y ?? NaN) + GRAPH_GEOMETRY.NODE_H / 2);
    expect(edge?.y2).toBe((agent?.y ?? NaN) + GRAPH_GEOMETRY.NODE_H / 2);
  });
});

describe("linkageSentences (screen-reader source of truth)", () => {
  it("states which agents read each corpus, one sentence per corpus", () => {
    expect(linkageSentences(SEED)).toEqual([
      {
        corpusSlug: "company",
        sentence:
          "Company — read by Cold Outbound Agent, Customer Support Bot, Sales Assistant",
      },
      {
        corpusSlug: "support-desk",
        sentence: "Support desk — read by Customer Support Bot",
      },
    ]);
  });

  it("says so plainly when a corpus has no reader", () => {
    const s = linkageSentences({
      corpora: [{ slug: "drafts", name: "Drafts" }],
      agents: [],
      agentLinks: [],
    });
    expect(s).toEqual([
      { corpusSlug: "drafts", sentence: "Drafts — read by no agent yet" },
    ]);
  });
});
