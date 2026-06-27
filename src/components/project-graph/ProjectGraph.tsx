import { useMemo } from "react";

import { CollectionCountBadge } from "@/components/ui/CollectionCountBadge";
import { compact } from "@/util";

import {
  columnX,
  GRAPH_GEOMETRY,
  type GraphInput,
  layout,
  linkageSentences,
} from "./layout";

const COLUMN_LABELS = ["Documents", "Collections", "Agents"] as const;

// The example/teaching graph (empty-state only): Documents →
// Collections → Agents, rendered from the pure `layout()`
// (deterministic, SSR-safe — no DOM measurement). It exists to show
// the system's shape — one document feeding many collections, read by
// many agents, no copies — at a glance.
// The populated project home is a dashboard, not a graph (a fixed-grid
// node diagram doesn't scale past a handful of docs and the live app
// can't enumerate MCP clients), so this renders no links and no live
// interaction. The sr-only list is the accessible source of truth,
// derived from the same data so visual and assistive paths can't diverge.

type Props = Readonly<GraphInput>;

// Horizontal S-curve between two edge anchor points. Control points sit
// halfway across the gap so the curve leaves/enters each node level —
// much calmer than crossing straight diagonals.
function curve(x1: number, y1: number, x2: number, y2: number): string {
  const mx = x1 + (x2 - x1) / 2;
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
}

export function ProjectGraph(props: Props): React.ReactElement {
  const g = useMemo(
    () =>
      layout(
        compact({
          documents: props.documents,
          collections: props.collections,
          attachments: props.attachments,
          agents: props.agents,
          agentLinks: props.agentLinks,
        }),
      ),
    [
      props.documents,
      props.collections,
      props.attachments,
      props.agents,
      props.agentLinks,
    ],
  );
  const sentences = useMemo(
    () =>
      linkageSentences({
        documents: props.documents,
        collections: props.collections,
        attachments: props.attachments,
      }),
    [props.documents, props.collections, props.attachments],
  );

  return (
    <div className="relative w-full overflow-x-auto">
      <ul className="sr-only" aria-label="Document linkage">
        {sentences.map((s) => (
          <li key={s.documentSlug}>{s.sentence}</li>
        ))}
      </ul>

      <div
        className="relative"
        style={{ width: g.width, height: g.height + 28 }}
        aria-hidden
      >
        {COLUMN_LABELS.map((label, col) => (
          <div
            key={label}
            className="absolute text-sm font-medium text-slate-500"
            style={{
              left: columnX(col as 0 | 1 | 2),
              top: 0,
              width: GRAPH_GEOMETRY.NODE_W,
            }}
          >
            {label}
          </div>
        ))}
        <div className="absolute inset-x-0" style={{ top: 28, bottom: 0 }}>
          <svg
            className="pointer-events-none absolute inset-0"
            width={g.width}
            height={g.height}
            role="img"
            aria-label="Example project graph"
          >
            {g.edges.map((e) => (
              <path
                key={e.id}
                d={curve(e.x1, e.y1, e.x2, e.y2)}
                fill="none"
                stroke="var(--color-slate-400)"
                strokeWidth={1.5}
                strokeDasharray="5 4"
              />
            ))}
          </svg>

          {g.nodes.map((n) => (
            <div
              key={n.id}
              className="absolute"
              style={{ left: n.x, top: n.y }}
            >
              <div
                className="flex flex-col justify-center rounded-md border border-dashed border-slate-300 bg-white px-3 text-base text-slate-400"
                style={{ width: n.w, height: n.h }}
              >
                <span className="truncate font-semibold">{n.label}</span>
                {n.kind === "document" && (n.collectionCount ?? 0) >= 1 && (
                  <CollectionCountBadge
                    count={n.collectionCount ?? 0}
                    className="mt-0.5"
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
