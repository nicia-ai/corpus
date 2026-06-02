import {
  EXAMPLE_AGENT_LINKS,
  EXAMPLE_AGENTS,
  EXAMPLE_ATTACHMENTS,
  EXAMPLE_COLLECTIONS,
  EXAMPLE_DOCS,
} from "@/sample-project";

// Pure, deterministic layout for the project graph. Zero DOM, zero IO:
// the same input always produces byte-identical output (slug-sorted, fixed
// grid), which is the property the "no reflow / no jitter" success
// criterion depends on. Consumed only by the empty-state teaching graph
// (ProjectGraph) — the populated home is a dashboard, not a node diagram.
//
//   col 0: Documents   col 1: Collections   col 2: Agents
//   [Doc]──includes──▶( Collection )──reads──▶[ Agent ]
//
// A document attached to multiple collections is ONE node with multiple
// outgoing edges (the "no copies" linkage made visible). The example
// supplies `agents` + `agentLinks` to illustrate concrete agents reading
// the collections.

export type GraphInput = Readonly<{
  documents: readonly Readonly<{ slug: string; title: string }>[];
  collections: readonly Readonly<{ slug: string; name: string }>[];
  attachments: readonly Readonly<{
    collectionSlug: string;
    documentSlug: string;
    position: number;
  }>[];
  // Example/ghost only — concrete agents reading the collections. Absent on
  // the live graph (col 2 is then the single MCP endpoint).
  agents?: readonly Readonly<{ slug: string; name: string }>[];
  agentLinks?: readonly Readonly<{
    agentSlug: string;
    collectionSlug: string;
  }>[];
}>;

export type NodeKind = "document" | "collection" | "agent";

export type GraphNode = Readonly<{
  id: string;
  kind: NodeKind;
  slug: string;
  label: string;
  col: 0 | 1 | 2;
  x: number;
  y: number;
  w: number;
  h: number;
  // documents only: number of distinct collections this doc is linked into.
  collectionCount?: number;
}>;

export type GraphEdge = Readonly<{
  id: string;
  fromId: string;
  toId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  // doc → collection edges carry the attachment position; collection →
  // agent edges do not.
  position?: number;
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

export const columnX = (col: 0 | 1 | 2): number =>
  PAD + col * (NODE_W + COL_GAP);
const colX = columnX;
const rowY = (row: number): number => PAD + row * ROW_GAP;
const bySlug = <T extends { slug: string }>(a: T, b: T): number =>
  a.slug.localeCompare(b.slug);

// Sorted distinct collections each document is attached to
// (slug-keyed), so the "In N collections" badge and edge fan-out are
// deterministic.
function collectionCounts(
  attachments: GraphInput["attachments"],
): ReadonlyMap<string, number> {
  const perDoc = new Map<string, Set<string>>();
  for (const a of attachments) {
    const set = perDoc.get(a.documentSlug) ?? new Set<string>();
    set.add(a.collectionSlug);
    perDoc.set(a.documentSlug, set);
  }
  return new Map([...perDoc].map(([slug, set]) => [slug, set.size]));
}

export function layout(input: GraphInput): GraphLayout {
  const documents = [...input.documents].sort(bySlug);
  const collections = [...input.collections].sort(bySlug);
  const empty = documents.length === 0 && collections.length === 0;

  const counts = collectionCounts(input.attachments);

  const docNodes: GraphNode[] = documents.map((d, i) => {
    const count = counts.get(d.slug);
    return {
      id: `document:${d.slug}`,
      kind: "document",
      slug: d.slug,
      label: d.title,
      col: 0,
      x: colX(0),
      y: rowY(i),
      w: NODE_W,
      h: NODE_H,
      ...(count === undefined ? {} : { collectionCount: count }),
    };
  });

  const colNodes: GraphNode[] = collections.map((c, i) => ({
    id: `collection:${c.slug}`,
    kind: "collection",
    slug: c.slug,
    label: c.name,
    col: 1,
    x: colX(1),
    y: rowY(i),
    w: NODE_W,
    h: NODE_H,
  }));

  // Column 2: the concrete agents reading the collections (one node each,
  // slug-sorted, top-aligned like the other columns).
  const agents = [...(input.agents ?? [])].sort(bySlug);
  const col2Nodes: readonly GraphNode[] = agents.map((a, i) => ({
    id: `agent:${a.slug}`,
    kind: "agent" as const,
    slug: a.slug,
    label: a.name,
    col: 2,
    x: colX(2),
    y: rowY(i),
    w: NODE_W,
    h: NODE_H,
  }));

  const nodeById = new Map<string, GraphNode>(
    [...docNodes, ...colNodes, ...col2Nodes].map((n) => [n.id, n]),
  );

  const rightMid = (n: GraphNode): readonly [number, number] => [
    n.x + n.w,
    n.y + n.h / 2,
  ];
  const leftMid = (n: GraphNode): readonly [number, number] => [
    n.x,
    n.y + n.h / 2,
  ];

  // doc → collection, sorted (collectionSlug, position, documentSlug)
  // so the edge list is stable across loads.
  const attachments = [...input.attachments].sort(
    (a, b) =>
      a.collectionSlug.localeCompare(b.collectionSlug) ||
      a.position - b.position ||
      a.documentSlug.localeCompare(b.documentSlug),
  );

  const docEdges: GraphEdge[] = [];
  for (const a of attachments) {
    const from = nodeById.get(`document:${a.documentSlug}`);
    const to = nodeById.get(`collection:${a.collectionSlug}`);
    if (from === undefined || to === undefined) continue;
    const [x1, y1] = rightMid(from);
    const [x2, y2] = leftMid(to);
    docEdges.push({
      id: `e:${a.documentSlug}->${a.collectionSlug}`,
      fromId: from.id,
      toId: to.id,
      x1,
      y1,
      x2,
      y2,
      position: a.position,
    });
  }

  // collection → agent: each declared (collection, agent) link, sorted
  // so the edge list is stable across loads.
  const links = [...(input.agentLinks ?? [])].sort(
    (a, b) =>
      a.collectionSlug.localeCompare(b.collectionSlug) ||
      a.agentSlug.localeCompare(b.agentSlug),
  );
  const col2Edges: GraphEdge[] = [];
  for (const l of links) {
    const from = nodeById.get(`collection:${l.collectionSlug}`);
    const to = nodeById.get(`agent:${l.agentSlug}`);
    if (from === undefined || to === undefined) continue;
    const [x1, y1] = rightMid(from);
    const [x2, y2] = leftMid(to);
    col2Edges.push({
      id: `e:${l.collectionSlug}->${l.agentSlug}`,
      fromId: from.id,
      toId: to.id,
      x1,
      y1,
      x2,
      y2,
    });
  }

  const nodes = [...docNodes, ...colNodes, ...col2Nodes];
  const rows = Math.max(documents.length, collections.length, agents.length, 1);
  return {
    nodes,
    edges: [...docEdges, ...col2Edges],
    width: colX(2) + NODE_W + PAD,
    height: rowY(rows - 1) + NODE_H + PAD,
    empty,
  };
}

// The screen-reader source of truth for linkage: one sentence per document
// listing the collections it feeds. Derived from the SAME data the visual
// layout uses, so the accessible and visual paths can never disagree.
export function linkageSentences(
  input: GraphInput,
): readonly Readonly<{ documentSlug: string; sentence: string }>[] {
  const colName = new Map(input.collections.map((c) => [c.slug, c.name]));
  const perDoc = new Map<string, Set<string>>();
  for (const a of input.attachments) {
    const set = perDoc.get(a.documentSlug) ?? new Set<string>();
    set.add(a.collectionSlug);
    perDoc.set(a.documentSlug, set);
  }
  return [...input.documents].sort(bySlug).map((d) => {
    const colSlugs = [...(perDoc.get(d.slug) ?? new Set<string>())].sort();
    const names = colSlugs.map((s) => colName.get(s) ?? s);
    const sentence =
      names.length === 0
        ? `${d.title} — not used by any collection`
        : `${d.title} — used by ${names.join(", ")}`;
    return { documentSlug: d.slug, sentence };
  });
}

// The canonical example shape: refund-policy linked into BOTH
// collections (the shared-node "no copies" moment), product and
// brand-voice into Sales only (one collection — present, not
// stranded). Document/collection/attachment shape and the markdown
// bodies live in `src/sample-project.ts` (the segregated demo
// content); the agent tier is ghost-only and stays here because the
// seed deliberately does not write it. Composing — not duplicating —
// the shared shape is how the preview and the actual seed avoid
// silently disagreeing.
export const EXAMPLE_GRAPH: GraphInput = {
  documents: EXAMPLE_DOCS.map(({ slug, title }) => ({ slug, title })),
  collections: EXAMPLE_COLLECTIONS,
  attachments: EXAMPLE_ATTACHMENTS,
  agents: EXAMPLE_AGENTS,
  agentLinks: EXAMPLE_AGENT_LINKS,
};
