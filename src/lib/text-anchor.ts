// Pure text-anchoring math, shared by selection capture and inline
// highlighting and free of any DOM dependency (so it is unit-testable
// without a browser). The DOM glue — building the rendered document's flat
// text and turning character spans into `Range`s — lives in `highlight.ts`.
//
// The point of both functions is to resolve the RIGHT occurrence of a
// phrase when it repeats: alignment resolves a selection by position in
// document order, and quote context resolves a stored anchor by its
// surrounding text. Neither uses a bare `indexOf`/`includes` that would
// silently pick the first match anywhere.

import { MIN_ANCHOR_CHARS } from "@/store/domain/anchor";

export type AnchorBlock = Readonly<{
  id?: string;
  index: number;
  text: string;
  sourceStart: number;
  sourceEnd: number;
}>;

export type SelectionAnchor = Readonly<{
  blockIndex: number;
  start: number;
  end: number;
  exact: string;
  sourceStart: number;
  sourceEnd: number;
}>;

export type AnchorQuote = Readonly<{
  prefix: string;
  exact: string;
  suffix: string;
}>;

export type HighlightAnchor = Readonly<{
  blockId: string;
  start: number;
  end: number;
  quote: AnchorQuote;
}>;

type AlignedBlock = AnchorBlock &
  Readonly<{
    at: number;
    end: number;
  }>;

function alignBlocks(
  full: string,
  blocks: readonly AnchorBlock[],
): readonly AlignedBlock[] {
  const out: AlignedBlock[] = [];
  let cursor = 0;
  for (const b of blocks) {
    if (b.text.length === 0) continue;
    const at = full.indexOf(b.text, cursor);
    if (at === -1) continue;
    const end = at + b.text.length;
    out.push({ ...b, at, end });
    cursor = end;
  }
  return out;
}

function isBlank(text: string): boolean {
  return text.trim() === "";
}

// Map a selection's character span in the rendered document text to the
// block it falls in and the offset within that block's text. Blocks are
// aligned to `full` IN DOCUMENT ORDER — a cursor advances past each match —
// so a block whose text also appears earlier still resolves to its own
// position, and a selection in the second of two identical paragraphs
// anchors to the second. A block whose text isn't present verbatim (e.g. a
// table row rendered without its `|` separators) is skipped rather than
// misattributed. A selection that includes meaningful text from multiple
// blocks is rejected; browser-added whitespace at a block boundary is
// clamped so native paragraph selection still resolves to that paragraph.
export function resolveAnchorInText(
  full: string,
  selStart: number,
  selEnd: number,
  blocks: readonly AnchorBlock[],
): SelectionAnchor | undefined {
  if (selEnd <= selStart) return undefined;
  for (const b of alignBlocks(full, blocks)) {
    if (selStart >= b.end || selEnd <= b.at) continue;
    const clampedStart = Math.max(selStart, b.at);
    const clampedEnd = Math.min(selEnd, b.end);
    if (clampedEnd <= clampedStart) continue;
    if (!isBlank(full.slice(selStart, clampedStart))) continue;
    if (!isBlank(full.slice(clampedEnd, selEnd))) continue;
    if (clampedEnd - clampedStart < MIN_ANCHOR_CHARS) continue;
    const start = clampedStart - b.at;
    const end = clampedEnd - b.at;
    return {
      blockIndex: b.index,
      start,
      end,
      exact: b.text.slice(start, end),
      sourceStart: b.sourceStart,
      sourceEnd: b.sourceEnd,
    };
  }
  return undefined;
}

// The character spans of a quote's `exact` text within `full`, located by
// its surrounding context: match `prefix + exact + suffix` and return the
// `exact` sub-span of each match. Context is what makes a repeated phrase
// highlight the RIGHT occurrence; if the bracketed quote isn't found (the
// text drifted), nothing is returned rather than a wrong span.
export function exactSpans(
  full: string,
  quote: AnchorQuote,
): readonly (readonly [number, number])[] {
  if (quote.exact.length === 0) return [];
  const needle = quote.prefix + quote.exact + quote.suffix;
  const spans: (readonly [number, number])[] = [];
  for (
    let i = full.indexOf(needle);
    i !== -1;
    i = full.indexOf(needle, i + needle.length)
  ) {
    const start = i + quote.prefix.length;
    spans.push([start, start + quote.exact.length]);
  }
  return spans;
}

// The character spans to paint for stored anchors. Prefer the current stable
// block id + offsets returned by the server; that disambiguates identical
// quote contexts in repeated paragraphs. Quote context remains a fallback
// for unmapped blocks or drifted data.
export function anchorSpansInText(
  full: string,
  blocks: readonly AnchorBlock[],
  anchors: readonly HighlightAnchor[],
): readonly (readonly [number, number])[] {
  const aligned = alignBlocks(full, blocks);
  const byId = new Map<string, AlignedBlock>();
  for (const block of aligned) {
    if (block.id !== undefined) byId.set(block.id, block);
  }
  const spans: (readonly [number, number])[] = [];
  for (const anchor of anchors) {
    const b = byId.get(anchor.blockId);
    if (
      b !== undefined &&
      anchor.end > anchor.start &&
      anchor.start >= 0 &&
      anchor.end <= b.text.length &&
      b.text.slice(anchor.start, anchor.end) === anchor.quote.exact
    ) {
      spans.push([b.at + anchor.start, b.at + anchor.end]);
      continue;
    }
    spans.push(...exactSpans(full, anchor.quote));
  }
  return spans;
}
