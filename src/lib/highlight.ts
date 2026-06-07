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
// Highlight styling is `::highlight(corpus-comment)` in styles.css.

const NAME = "corpus-comment";

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

// Highlight each open thread's quoted text at its own occurrence, located
// by its current stable block anchor first, with quote context as fallback.
export function applyHighlights(
  container: HTMLElement,
  anchors: readonly HighlightAnchor[],
  blocks: readonly AnchorBlock[],
): void {
  if (!("highlights" in CSS)) return;
  const idx = buildIndex(container);
  const ranges: Range[] = [];
  for (const [start, end] of anchorSpansInText(idx.full, blocks, anchors)) {
    const range = rangeAt(idx, start, end);
    if (range !== undefined) ranges.push(range);
  }
  if (ranges.length === 0) {
    CSS.highlights.delete(NAME);
    return;
  }
  CSS.highlights.set(NAME, new Highlight(...ranges));
}

export function clearHighlights(): void {
  if ("highlights" in CSS) CSS.highlights.delete(NAME);
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
