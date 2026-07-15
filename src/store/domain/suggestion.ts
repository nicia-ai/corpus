import { asBlockId, type BlockId } from "../../ids";

import { type Block, matchBlocks, type NextBlock } from "./block-match";
import { parseBlocksWithRanges } from "./block-parse";

// Suggestions as block-level hunks. A suggestion is a proposed alternative
// markdown for a document; `diffToHunks` turns base+proposed into an ordered
// list of block edits (each carrying a source range in the BASE), and
// `applyHunks` splices a chosen subset back into the base to produce the new
// markdown. Pure, zero-IO.
//
// v1 captures replace / insert / delete at block granularity. A pure MOVE
// (same content relocated) carries as unchanged and yields no hunk — moves
// are not represented in a suggestion yet.

// Create-proposals reuse the suggestion table with this base version as the
// discriminant: a real document's head is never below 1 (see nextVersion), so
// 0 can only mean "this document does not exist yet". A create-proposal
// carries no hunks — the whole body is the proposal.
export const CREATE_PROPOSAL_BASE_VERSION = 0;

export type ProposalStatus = "open" | "applied" | "rejected" | "stale";
export type ProposalOutcome = ProposalStatus | "partially_applied";

// Reviewers persist only the four storage statuses. Partial application is
// derived from the terminal hunk decisions so it cannot drift from what was
// actually applied or require a fifth stored status.
export function computeProposalOutcome(
  status: ProposalStatus,
  hunks: readonly Readonly<{
    decision: "pending" | "accepted" | "rejected";
  }>[],
): ProposalOutcome {
  if (status !== "applied" || hunks.length === 0) return status;
  const accepted = hunks.filter((hunk) => hunk.decision === "accepted").length;
  return accepted < hunks.length ? "partially_applied" : status;
}

export function isCreateProposal(
  row: Readonly<{ baseDocVersion: number }>,
): boolean {
  return row.baseDocVersion === CREATE_PROPOSAL_BASE_VERSION;
}

// Single source for the hunk-op vocabulary (the DO schema consumes this
// tuple for its enum column + CHECK, the same way it consumes BLOCK_KINDS).
export const HUNK_OPS = ["replace", "insert", "delete"] as const;
export type HunkOp = (typeof HUNK_OPS)[number];

export type Hunk = Readonly<{
  // Position in the proposed document order (also the apply tiebreak).
  ordinal: number;
  op: HunkOp;
  // Half-open base source range. For `insert` it is zero-width at the seam.
  baseStart: number;
  baseEnd: number;
  // New source for replace / insert; empty for delete.
  proposedText: string;
}>;

const baseIndexOf = (id: BlockId): number => Number(id.slice(1));

export function diffToHunks(base: string, proposed: string): readonly Hunk[] {
  const baseBlocks = parseBlocksWithRanges(base);
  const proposedBlocks = parseBlocksWithRanges(proposed);
  const prev: Block[] = baseBlocks.map((b, i) => ({
    id: asBlockId(`b${i.toString()}`),
    kind: b.kind,
    text: b.text,
  }));
  const next: NextBlock[] = proposedBlocks.map((b) => ({
    kind: b.kind,
    text: b.text,
  }));
  let minted = 0;
  const match = matchBlocks({
    prev,
    next,
    mintId: () => asBlockId(`n${(minted += 1).toString()}`),
  });

  const hunks: Hunk[] = [];
  const carried = new Set<number>();
  let ordinal = 0;
  // The base offset a new (inserted) block is anchored after: the end of
  // the most recent kept/edited base block, or document start.
  let seam = 0;

  match.blocks.forEach((mb, j) => {
    const pb = proposedBlocks[j];
    if (pb === undefined) return;
    const proposedText = proposed.slice(pb.sourceStart, pb.sourceEnd);
    const origin = mb.origin;
    if (origin.status === "unchanged") {
      const i = baseIndexOf(origin.fromId);
      carried.add(i);
      seam = baseBlocks[i]?.sourceEnd ?? seam;
    } else if (origin.status === "modified") {
      const i = baseIndexOf(origin.fromId);
      const bb = baseBlocks[i];
      if (bb === undefined) return;
      carried.add(i);
      hunks.push({
        ordinal: (ordinal += 1),
        op: "replace",
        baseStart: bb.sourceStart,
        baseEnd: bb.sourceEnd,
        proposedText,
      });
      seam = bb.sourceEnd;
    } else {
      hunks.push({
        ordinal: (ordinal += 1),
        op: "insert",
        baseStart: seam,
        baseEnd: seam,
        proposedText,
      });
    }
  });

  baseBlocks.forEach((bb, i) => {
    if (!carried.has(i)) {
      hunks.push({
        ordinal: (ordinal += 1),
        op: "delete",
        baseStart: bb.sourceStart,
        baseEnd: bb.sourceEnd,
        proposedText: "",
      });
    }
  });

  return hunks;
}

// Splice the given (already-decided) hunks into the base markdown. Hunks are
// non-overlapping block ranges; a single forward walk applies them in source
// order. Inserts get blank-line separators; runs of blank lines left by
// deletes are collapsed.
export function applyHunks(base: string, hunks: readonly Hunk[]): string {
  const ordered = [...hunks].sort(
    (a, b) => a.baseStart - b.baseStart || a.ordinal - b.ordinal,
  );
  let cursor = 0;
  let out = "";
  for (const h of ordered) {
    if (h.baseStart < cursor) continue; // defensive: skip an overlap
    out += base.slice(cursor, h.baseStart);
    if (h.op === "replace") {
      out += h.proposedText;
      cursor = h.baseEnd;
    } else if (h.op === "insert") {
      out +=
        h.baseStart === 0 ? `${h.proposedText}\n\n` : `\n\n${h.proposedText}`;
      cursor = h.baseEnd;
    } else {
      cursor = h.baseEnd;
    }
  }
  out += base.slice(cursor);
  return collapseBlankRunsOutsideCode(out)
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");
}

// Collapse runs of blank lines to a single blank line (the gaps a delete
// leaves), but NEVER inside a fenced code block — there blank lines are
// significant content. Equivalent to `/\n{3,}/→\n\n` for prose while leaving
// ``` / ~~~ fences intact, so applying a suggestion can't silently rewrite a
// code sample's blank lines.
function collapseBlankRunsOutsideCode(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let fence: string | undefined;
  let blankRun = 0;
  for (const line of lines) {
    const trimmed = line.trimStart();
    const run = /^(`{3,}|~{3,})/.exec(trimmed)?.[1];
    if (fence === undefined) {
      if (run !== undefined) fence = run[0];
    } else if (run?.[0] === fence) {
      fence = undefined;
    }
    if (fence === undefined && line.trim() === "") {
      blankRun += 1;
      if (blankRun >= 2) continue; // keep at most one blank line
    } else {
      blankRun = 0;
    }
    out.push(line);
  }
  return out.join("\n");
}
