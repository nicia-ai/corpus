import type { InlineSuggestionMark } from "./review-items";
import {
  type AnchorBlock,
  anchorSpansInText,
  type HighlightAnchor,
  resolveAnchorInText,
  type SelectionAnchor,
} from "./text-anchor";

// DOM glue for text anchoring in the rendered document. Inline highlighting
// uses the CSS Custom Highlight API: it paints arbitrary `Range`s WITHOUT
// mutating the DOM (so it survives react re-renders and crosses inline
// boundaries), and degrades to nothing where unsupported. The pure
// character math — which occurrence of a phrase — lives in `text-anchor.ts`;
// here we only flatten the container's text and turn spans into `Range`s.
// Highlight styling uses `::highlight(corpus-*)`. Keep those rules out of
// styles.css because Lightning CSS currently warns on the valid Custom
// Highlight API pseudo-element while minifying the app stylesheet.

const COMMENT = "corpus-comment";
const SUGGESTION_REPLACE = "corpus-suggestion-replace";
const SUGGESTION_DELETE = "corpus-suggestion-delete";
const SUGGESTION_INSERT = "corpus-suggestion-insert";
const ALL_NAMES = [
  COMMENT,
  SUGGESTION_REPLACE,
  SUGGESTION_DELETE,
  SUGGESTION_INSERT,
] as const;
const HIGHLIGHT_STYLE_ID = "corpus-custom-highlight-styles";
const HIGHLIGHT_STYLES = `
::highlight(corpus-comment) {
  background-color: #fef3c7;
}

::highlight(corpus-suggestion-replace) {
  background-color: #dcfce7;
}

::highlight(corpus-suggestion-delete) {
  background-color: #ffe4e6;
  color: #9f1239;
  text-decoration-line: line-through;
}

::highlight(corpus-suggestion-insert) {
  background-color: #bbf7d0;
  color: #166534;
  text-decoration-line: underline;
  text-decoration-thickness: 2px;
  text-underline-offset: 3px;
}
`.trim();

function supportsHighlights(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof Highlight !== "undefined"
  );
}

function ensureHighlightStyles(): void {
  if (document.getElementById(HIGHLIGHT_STYLE_ID) !== null) return;
  const style = document.createElement("style");
  style.id = HIGHLIGHT_STYLE_ID;
  style.textContent = HIGHLIGHT_STYLES;
  document.head.appendChild(style);
}

function isText(node: Node): node is Text {
  return node.nodeType === Node.TEXT_NODE;
}

// A flat view of an element's rendered text: the concatenated string plus a
// per-text-node cumulative start, so a character position maps back to a
// (text node, offset). Built once per operation.
type TextIndex = Readonly<{
  full: string;
  nodes: readonly Text[];
  starts: readonly number[];
}>;

function buildIndex(container: HTMLElement): TextIndex {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const starts: number[] = [];
  let full = "";
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    if (!isText(n)) continue;
    starts.push(full.length);
    nodes.push(n);
    full += n.nodeValue ?? "";
  }
  return { full, nodes, starts };
}

type Located = Readonly<{ node: Text; offset: number }>;

export type AnchorPositionTarget = Readonly<{
  id: string;
  anchor: HighlightAnchor;
}>;

export type HighlightRect = Readonly<{
  key: string;
  top: number;
  left: number;
  width: number;
  height: number;
}>;

// The (text node, offset) for a position in the concatenated text — the
// last node whose cumulative start is at or before `pos`.
function locate(idx: TextIndex, pos: number): Located | undefined {
  for (let i = idx.nodes.length - 1; i >= 0; i -= 1) {
    const start = idx.starts[i];
    const node = idx.nodes[i];
    if (start !== undefined && node !== undefined && start <= pos) {
      return { node, offset: pos - start };
    }
  }
  return undefined;
}

function rangeAt(
  idx: TextIndex,
  start: number,
  end: number,
): Range | undefined {
  const a = locate(idx, start);
  const b = locate(idx, end);
  if (a === undefined || b === undefined) return undefined;
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  return range;
}

function blockSpansInText(
  full: string,
  blocks: readonly AnchorBlock[],
): readonly (readonly [AnchorBlock, number, number])[] {
  const out: (readonly [AnchorBlock, number, number])[] = [];
  let cursor = 0;
  for (const block of blocks) {
    if (block.text.length === 0) continue;
    const start = full.indexOf(block.text, cursor);
    if (start === -1) continue;
    const end = start + block.text.length;
    out.push([block, start, end]);
    cursor = end;
  }
  return out;
}

export function measureBlockRects({
  container,
  frame,
  blocks,
  blockIndexes,
}: Readonly<{
  container: HTMLElement;
  frame: HTMLElement;
  blocks: readonly AnchorBlock[];
  blockIndexes: readonly number[];
}>): readonly HighlightRect[] {
  const wanted = new Set(blockIndexes);
  if (wanted.size === 0) return [];
  const idx = buildIndex(container);
  const frameRect = frame.getBoundingClientRect();
  const rects: HighlightRect[] = [];
  for (const [block, start, end] of blockSpansInText(idx.full, blocks)) {
    if (!wanted.has(block.index)) continue;
    const range = rangeAt(idx, start, end);
    if (range === undefined) continue;
    [...range.getClientRects()].forEach((rect, i) => {
      if (rect.width <= 0 || rect.height <= 0) return;
      rects.push({
        key: `${block.index}:${i}:${Math.round(rect.top)}:${Math.round(rect.left)}`,
        top: rect.top - frameRect.top,
        left: rect.left - frameRect.left,
        width: rect.width,
        height: rect.height,
      });
    });
  }
  return rects;
}

export function measureAnchorTops({
  container,
  frame,
  targets,
  blocks,
}: Readonly<{
  container: HTMLElement;
  frame: HTMLElement;
  targets: readonly AnchorPositionTarget[];
  blocks: readonly AnchorBlock[];
}>): Readonly<Record<string, number>> {
  const idx = buildIndex(container);
  const frameTop = frame.getBoundingClientRect().top;
  const out: Record<string, number> = {};
  for (const target of targets) {
    const span = anchorSpansInText(idx.full, blocks, [target.anchor])[0];
    if (span === undefined) continue;
    const range = rangeAt(idx, span[0], span[1]);
    const rect = range?.getClientRects()[0] ?? range?.getBoundingClientRect();
    if (rect === undefined) continue;
    out[target.id] = Math.max(0, Math.round(rect.top - frameTop));
  }
  return out;
}

// The character offset of a DOM position within `container`'s flat text —
// the length of the rendered text preceding it. Works whether the position
// is in a text node or at an element boundary, and aligns with the same
// concatenation `buildIndex` produces.
function offsetOf(
  container: HTMLElement,
  node: Node,
  nodeOffset: number,
): number {
  const r = document.createRange();
  r.setStart(container, 0);
  r.setEnd(node, nodeOffset);
  return r.toString().length;
}

function setHighlight(
  name: string,
  container: HTMLElement,
  anchors: readonly HighlightAnchor[],
  blocks: readonly AnchorBlock[],
): void {
  if (!supportsHighlights()) return;
  const idx = buildIndex(container);
  const ranges: Range[] = [];
  for (const [start, end] of anchorSpansInText(idx.full, blocks, anchors)) {
    const range = rangeAt(idx, start, end);
    if (range !== undefined) ranges.push(range);
  }
  if (ranges.length === 0) {
    CSS.highlights.delete(name);
    return;
  }
  ensureHighlightStyles();
  CSS.highlights.set(name, new Highlight(...ranges));
}

// Highlight each open thread's quoted text at its own occurrence, located
// by its current stable block anchor first, with quote context as fallback.
export function applyHighlights(
  container: HTMLElement,
  anchors: readonly HighlightAnchor[],
  blocks: readonly AnchorBlock[],
): void {
  setHighlight(COMMENT, container, anchors, blocks);
}

export function applyReviewHighlights({
  container,
  comments,
  suggestions,
  blocks,
}: Readonly<{
  container: HTMLElement;
  comments: readonly HighlightAnchor[];
  suggestions: readonly InlineSuggestionMark[];
  blocks: readonly AnchorBlock[];
}>): void {
  applyHighlights(container, comments, blocks);
  setHighlight(
    SUGGESTION_REPLACE,
    container,
    suggestions.filter((m) => m.op === "replace").map((m) => m.anchor),
    blocks,
  );
  setHighlight(
    SUGGESTION_DELETE,
    container,
    suggestions.filter((m) => m.op === "delete").map((m) => m.anchor),
    blocks,
  );
  setHighlight(
    SUGGESTION_INSERT,
    container,
    suggestions.filter((m) => m.op === "insert").map((m) => m.anchor),
    blocks,
  );
}

export function clearHighlights(): void {
  if (!supportsHighlights()) return;
  for (const name of ALL_NAMES) CSS.highlights.delete(name);
}

// Resolve a live DOM selection to a block anchor: which block it lies in
// and the offset within that block's text. Derived from the selection's
// actual position (not a content search), so a selection in a repeated
// paragraph — or a repeated phrase within one block — anchors correctly.
export function resolveSelectionAnchor(
  container: HTMLElement,
  range: Range,
  blocks: readonly AnchorBlock[],
): SelectionAnchor | undefined {
  const idx = buildIndex(container);
  const selStart = offsetOf(container, range.startContainer, range.startOffset);
  const selEnd = offsetOf(container, range.endContainer, range.endOffset);
  return resolveAnchorInText(idx.full, selStart, selEnd, blocks);
}
