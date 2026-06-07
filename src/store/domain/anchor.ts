import type { BlockId } from "../../ids";

import type { MatchedBlock, MatchResult } from "./block-match";

// Anchors: how a comment or suggestion pins to a location in a document,
// and how that pin survives an edit. Pure, zero-IO.
//
// An anchor is structural — a block id plus an intra-block character range
// — backed by a text quote (the exact selected text plus a little context
// on each side). Rebasing across a save relocates the anchor by FINDING
// the quoted text again:
//
//   1. in the block the matcher carried this id to (unchanged or modified),
//   2. failing that, anywhere it survived in the new document (so a comment
//      follows text that was cut from one block and pasted into another),
//   3. failing that, the anchor orphans — it is never silently moved onto
//      different text.
//
// Invariant, by construction: a returned `anchored` result's range always
// slices back to exactly the original quoted text. Wrong-text landings are
// impossible; the failure mode is an honest orphan.

// Characters of surrounding context captured on each side of the
// selection, used to disambiguate which occurrence of the quote is meant.
const QUOTE_CONTEXT = 32;

export type TextQuote = Readonly<{
  prefix: string;
  exact: string;
  suffix: string;
}>;

export type Anchor = Readonly<{
  blockId: BlockId;
  start: number;
  end: number;
  quote: TextQuote;
}>;

export type RebaseResult = Readonly<
  | { status: "anchored"; anchor: Anchor }
  | { status: "orphaned"; quote: TextQuote }
>;

// Capture an anchor over [start, end) of a block's text, with context.
export function resolveAnchor(
  block: Readonly<{ id: BlockId; text: string }>,
  start: number,
  end: number,
): Anchor {
  return {
    blockId: block.id,
    start,
    end,
    quote: {
      prefix: block.text.slice(Math.max(0, start - QUOTE_CONTEXT), start),
      exact: block.text.slice(start, end),
      suffix: block.text.slice(end, end + QUOTE_CONTEXT),
    },
  };
}

// Rebase every anchor through one save's MatchResult. The index over the
// new blocks is built once and shared.
export function rebaseAnchors(
  anchors: readonly Anchor[],
  match: MatchResult,
): readonly RebaseResult[] {
  const index = buildIndex(match);
  return anchors.map((anchor) => rebaseOne(anchor, index));
}

type RebaseIndex = Readonly<{
  // prev block id → the new block the matcher carried it to.
  carried: ReadonlyMap<BlockId, MatchedBlock>;
  // all new blocks, in document order, for cross-block recovery.
  blocks: readonly MatchedBlock[];
}>;

function buildIndex(match: MatchResult): RebaseIndex {
  const carried = new Map<BlockId, MatchedBlock>();
  for (const block of match.blocks) {
    const { origin } = block;
    if (origin.status === "unchanged" || origin.status === "modified") {
      carried.set(origin.fromId, block);
    }
  }
  return { carried, blocks: match.blocks };
}

function rebaseOne(anchor: Anchor, index: RebaseIndex): RebaseResult {
  // 1. The block this id was carried to.
  const carried = index.carried.get(anchor.blockId);
  if (carried !== undefined) {
    const at = locate(carried.text, anchor.quote);
    if (at !== undefined) return placed(carried.id, at, anchor.quote);
  }
  // 2. Anywhere else the quote survived (cut-and-pasted content, or the
  //    carrying block dropped the quote).
  for (const block of index.blocks) {
    if (block.id === carried?.id) continue;
    const at = locate(block.text, anchor.quote);
    if (at !== undefined) return placed(block.id, at, anchor.quote);
  }
  // 3. Gone.
  return { status: "orphaned", quote: anchor.quote };
}

function placed(
  blockId: BlockId,
  start: number,
  quote: TextQuote,
): RebaseResult {
  return {
    status: "anchored",
    anchor: { blockId, start, end: start + quote.exact.length, quote },
  };
}

// Find the offset of `quote.exact` in `text`. When the exact text occurs
// more than once (or is empty — a caret), the surrounding prefix/suffix
// pick the best-matching occurrence. Returns undefined if the exact text
// is absent.
function locate(text: string, quote: TextQuote): number | undefined {
  const { exact, prefix, suffix } = quote;
  const candidates = occurrences(text, exact);
  if (candidates.length === 0) return undefined;

  let best = -1;
  let bestScore = -1;
  for (const at of candidates) {
    const score =
      commonSuffixLength(text.slice(0, at), prefix) +
      commonPrefixLength(text.slice(at + exact.length), suffix);
    if (score > bestScore) {
      bestScore = score;
      best = at;
    }
  }
  return best < 0 ? undefined : best;
}

function occurrences(text: string, exact: string): readonly number[] {
  // Empty quote (a caret) can sit at any offset; context decides which.
  if (exact === "") return Array.from({ length: text.length + 1 }, (_, i) => i);
  const out: number[] = [];
  let i = text.indexOf(exact);
  while (i !== -1) {
    out.push(i);
    i = text.indexOf(exact, i + 1);
  }
  return out;
}

function commonSuffixLength(a: string, b: string): number {
  let n = 0;
  while (
    n < a.length &&
    n < b.length &&
    a[a.length - 1 - n] === b[b.length - 1 - n]
  ) {
    n += 1;
  }
  return n;
}

function commonPrefixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}
