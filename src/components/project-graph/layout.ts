import {
  EXAMPLE_AGENT_LINKS,
  EXAMPLE_AGENTS,
  EXAMPLE_COLLECTIONS,
} from "@/sample-project";

// Pure, deterministic layout for the project graph. Zero DOM, zero IO:
// the same input always produces byte-identical output (slug-sorted, fixed
// grid), which is the property the "no reflow / no jitter" success
// criterion depends on. Consumed only by the empty-state teaching graph
// (ProjectGraph) — the populated home is a dashboard, not a node diagram.
//
//   col 0: Corpora   col 1: Agents
//   ( Corpus )──reads──▶[ Agent ]
//
// One corpus feeds many agents (the "no copies" linkage made visible), and
// an agent that needs two audiences' knowledge connects to two corpora —
// no document ever sits in two.

export type GraphInput = Readonly<{
  corpora: readonly Readonly<{ slug: string; name: string }>[];
  agents: readonly Readonly<{ slug: string; name: string }>[];
  agentLinks: readonly Readonly<{
    agentSlug: string;
    corpusSlug: string;
  }>[];
}>;

export type NodeKind = "corpus" | "agent";

export type GraphNode = Readonly<{
  id: string;
  kind: NodeKind;
  slug: string;
  label: string;
  col: 0 | 1;
  x: number;
  y: number;
  w: number;
  h: number;
}>;

export type GraphEdge = Readonly<{
  id: string;
  fromId: string;
  toId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}>;

export type GraphLayout = Readonly<{
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  width: number;
  height: number;
  empty: boolean;
}>;

// The fixed grid. Exported so the component's column headers / skeleton
// stay locked to the same numbers the nodes are placed on (no re-inlined
// literals that can silently desync).
export const GRAPH_GEOMETRY = {
  NODE_W: 240,
  NODE_H: 64,
  COL_GAP: 220,
  ROW_GAP: 100,
  PAD: 24,
} as const;
const { NODE_W, NODE_H, COL_GAP, ROW_GAP, PAD } = GRAPH_GEOMETRY;

export const columnX = (col: 0 | 1): number => PAD + col * (NODE_W + COL_GAP);
const rowY = (row: number): number => PAD + row * ROW_GAP;
const bySlug = <T extends { slug: string }>(a: T, b: T): number =>
  a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;

export function layout(input: GraphInput): GraphLayout {
  const corpora = [...input.corpora].sort(bySlug);
  const agents = [...input.agents].sort(bySlug);

  const corpusNodes: GraphNode[] = corpora.map((c, i) => ({
    id: `corpus:${c.slug}`,
    kind: "corpus",
    slug: c.slug,
    label: c.name,
    col: 0,
    x: columnX(0),
    y: rowY(i),
    w: NODE_W,
    h: NODE_H,
  }));
  const agentNodes: GraphNode[] = agents.map((a, i) => ({
    id: `agent:${a.slug}`,
    kind: "agent",
    slug: a.slug,
    label: a.name,
    col: 1,
    x: columnX(1),
    y: rowY(i),
    w: NODE_W,
    h: NODE_H,
  }));

  const nodeById = new Map<string, GraphNode>(
    [...corpusNodes, ...agentNodes].map((n) => [n.id, n]),
  );

  // corpus → agent: each declared (corpus, agent) link, sorted so the
  // edge list is stable across loads.
  const links = [...input.agentLinks].sort(
    (a, b) =>
      (a.corpusSlug < b.corpusSlug
        ? -1
        : a.corpusSlug > b.corpusSlug
          ? 1
          : 0) ||
      (a.agentSlug < b.agentSlug ? -1 : a.agentSlug > b.agentSlug ? 1 : 0),
  );
  const edges: GraphEdge[] = [];
  for (const l of links) {
    const from = nodeById.get(`corpus:${l.corpusSlug}`);
    const to = nodeById.get(`agent:${l.agentSlug}`);
    if (from === undefined || to === undefined) continue;
    edges.push({
      id: `e:${l.corpusSlug}->${l.agentSlug}`,
      fromId: from.id,
      toId: to.id,
      x1: from.x + from.w,
      y1: from.y + from.h / 2,
      x2: to.x,
      y2: to.y + to.h / 2,
    });
  }

  const rows = Math.max(corpora.length, agents.length, 1);
  return {
    nodes: [...corpusNodes, ...agentNodes],
    edges,
    width: columnX(1) + NODE_W + PAD,
    height: rowY(rows - 1) + NODE_H + PAD,
    empty: corpora.length === 0 && agents.length === 0,
  };
}

// The screen-reader source of truth for linkage: one sentence per corpus
// listing the agents that read it. Derived from the SAME data the visual
// layout uses, so the accessible and visual paths can never disagree.
export function linkageSentences(
  input: GraphInput,
): readonly Readonly<{ corpusSlug: string; sentence: string }>[] {
  const agentName = new Map(input.agents.map((a) => [a.slug, a.name]));
  return [...input.corpora].sort(bySlug).map((c) => {
    const names = input.agentLinks
      .filter((l) => l.corpusSlug === c.slug)
      .map((l) => agentName.get(l.agentSlug) ?? l.agentSlug)
      .sort();
    return {
      corpusSlug: c.slug,
      sentence:
        names.length === 0
          ? `${c.name} — read by no agent yet`
          : `${c.name} — read by ${names.join(", ")}`,
    };
  });
}

// The canonical example shape: a company corpus read by three agents, and
// a support-desk corpus that the support bot reads alongside it. The
// corpora and the agent links live in `src/sample-project.ts` (the
// segregated demo content); the agent tier is ghost-only because the seed
// deliberately does not write it. Composing — not duplicating — the shared
// shape is how the preview and the actual seed avoid silently disagreeing.
export const EXAMPLE_GRAPH: GraphInput = {
  corpora: EXAMPLE_COLLECTIONS,
  agents: EXAMPLE_AGENTS,
  agentLinks: EXAMPLE_AGENT_LINKS,
};
