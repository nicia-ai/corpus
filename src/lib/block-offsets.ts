import { processor } from "@nicia-ai/prose-diff";
import type { Nodes } from "mdast";

import {
  type AnchorBlock,
  type AnchorQuote,
  exactSpans,
} from "@/lib/text-anchor";

// The boundary adapter between the CodeMirror editor (which addresses the
// document in MARKDOWN SOURCE offsets) and the comment anchor model (which
// addresses a block in PLAIN-TEXT offsets — `block.text = mdastToString(node)`,
// markers stripped; see @nicia-ai/prose-diff's block-parse.ts). The server anchor
// model, rebase, and quote recovery all stay in plain text and are untouched;
// this module only translates an editor selection into the `createComment`
// inputs and back into a source range to paint.
//
// Pure and zero-DOM (unit-testable without a browser). It re-parses a single
// block's source slice with the same remark family the block parser uses, so
// the derived plain text agrees with `block.text`; when it can't reproduce that
// (table rows, which the block parser formats as `a | b`, or a slice that
// doesn't round-trip), it declines rather than emit a wrong offset.

export type SourceBlockAnchor = Readonly<{
  blockIndex: number;
  start: number;
  end: number;
}>;

type PlainMap = Readonly<{
  // The block's plain text, rebuilt from its source slice.
  plain: string;
  // offsets[i] is the ABSOLUTE document source offset of plain[i]; length ===
  // plain.length. A run of source markers between two plain chars simply leaves
  // a gap in the values, never a gap in the array.
  offsets: readonly number[];
  // False when a leaf's decoded value did not literally appear at its expected
  // source position — markdown escapes (`\*`), HTML entities (`&amp;`), or a
  // fence/backtick form we don't map precisely. The 1:1 char map would drift,
  // so callers MUST decline rather than emit a wrong offset (the module's
  // promise). Untrusted is safe-but-conservative, never wrong.
  trusted: boolean;
}>;

// Map `value`'s chars to absolute source offsets starting at `srcStart`, but
// only if the source literally contains `value` there. A mismatch means the
// decode diverged from the source (escape/entity/space-stripping) and the 1:1
// assumption is unsafe → return false so the caller marks the block untrusted.
function appendAt(
  plain: string[],
  offsets: number[],
  slice: string,
  base: number,
  value: string,
  srcStart: number,
): boolean {
  if (srcStart < 0 || !slice.startsWith(value, srcStart)) return false;
  for (let i = 0; i < value.length; i += 1) {
    plain.push(value[i] ?? "");
    offsets.push(base + srcStart + i);
  }
  return true;
}

// Walk the block's inline tree, appending each leaf's text + source offsets.
// Returns whether every contributing leaf mapped cleanly (see appendAt).
function walk(
  node: Nodes,
  slice: string,
  base: number,
  plain: string[],
  offsets: number[],
): boolean {
  const start = node.position?.start.offset ?? 0;
  switch (node.type) {
    case "text":
    case "html":
      return appendAt(plain, offsets, slice, base, node.value, start);
    case "inlineCode":
      // Common form: a single backtick, content immediately after. Other forms
      // (double backtick, space-stripped) fail the literal check → untrusted.
      return appendAt(plain, offsets, slice, base, node.value, start + 1);
    case "code": {
      // Fenced code: the value is the body after the opening fence line. An
      // indented fence (a list item / blockquote continuation) has that same
      // indentation stripped from EVERY body line by CommonMark, so `value`
      // no longer appears as one contiguous literal run in `slice` — map it
      // line-by-line instead, pairing each of `value`'s lines with its
      // source line and mapping the line-break itself to the source's own
      // newline (a precise, not approximate, correspondence).
      const firstLineEnd = slice.indexOf("\n", start);
      if (firstLineEnd === -1) return false;
      let cursor = firstLineEnd + 1;
      let trusted = true;
      node.value.split("\n").forEach((line, i) => {
        if (i > 0) {
          plain.push("\n");
          offsets.push(base + cursor - 1);
        }
        const nextBreak = slice.indexOf("\n", cursor);
        const lineEnd = nextBreak === -1 ? slice.length : nextBreak;
        const at = slice.slice(cursor, lineEnd).indexOf(line);
        if (
          at === -1 ||
          !appendAt(plain, offsets, slice, base, line, cursor + at)
        ) {
          trusted = false;
        }
        cursor = lineEnd === slice.length ? lineEnd : lineEnd + 1;
      });
      return trusted;
    }
    case "image":
      // mdast-util-to-string includes image alt (includeImageAlt default); the
      // alt text follows the leading `![`.
      return node.alt
        ? appendAt(plain, offsets, slice, base, node.alt, start + 2)
        : true;
    case "listItem": {
      // block-parse.ts's emitListItems builds a list-item block's `.text` as
      // `ownText.join("\n")` — the item's own (non-list) children joined
      // with "\n" — unlike mdastToString's default plain concatenation. A
      // nested `list` child is a separate block (its own items), so it's
      // skipped here exactly as emitListItems skips it from `ownText`.
      let trusted = true;
      const ownChildren = node.children.filter(
        (child) => child.type !== "list",
      );
      ownChildren.forEach((child, i) => {
        if (i > 0) {
          // The gap between two own children always contains at least a
          // blank line, so the real source character one past the previous
          // child's last mapped offset is itself blank/structural (never
          // another plain char) — a safe, strictly-greater position for the
          // synthetic join, distinct from the previous child's last offset
          // (reusing it would let a selection landing exactly on that
          // boundary spuriously swallow this "\n" too).
          const prevOffset = offsets[offsets.length - 1];
          plain.push("\n");
          offsets.push(prevOffset === undefined ? base : prevOffset + 1);
        }
        if (!walk(child, slice, base, plain, offsets)) trusted = false;
      });
      return trusted;
    }
    default: {
      if (!("children" in node)) return true;
      let trusted = true;
      for (const child of node.children) {
        if (!walk(child, slice, base, plain, offsets)) trusted = false;
      }
      return trusted;
    }
  }
}

function buildPlainMap(slice: string, base: number): PlainMap {
  const plain: string[] = [];
  const offsets: number[] = [];
  const trusted = walk(processor.parse(slice), slice, base, plain, offsets);
  return { plain: plain.join(""), offsets, trusted };
}

function blockContaining(
  blocks: readonly AnchorBlock[],
  pos: number,
): AnchorBlock | undefined {
  return blocks.find((b) => pos >= b.sourceStart && pos < b.sourceEnd);
}

// Translate an editor selection [from, to) in document source into the block +
// intra-block PLAIN offsets `createComment` expects. The selection is clamped
// to the block that contains its start; source positions that fall on hidden
// markers (e.g. the `*` of `**bold**`) simply contribute no plain char, so the
// anchor naturally snaps to the visible text. Returns undefined when the
// selection spans no plain text or the block's plain text can't be reproduced
// from its source (e.g. a table row).
export function sourceRangeToBlockAnchor(
  blocks: readonly AnchorBlock[],
  source: string,
  from: number,
  to: number,
): SourceBlockAnchor | undefined {
  if (to <= from) return undefined;
  const block = blockContaining(blocks, from);
  if (block === undefined) return undefined;
  // A selection that runs past this block's end is only acceptable when the
  // overrun is blank (e.g. the blank line before the next block) — that's
  // still "this block" plus incidental whitespace. Anything else is
  // meaningful text from another block, which this anchor model doesn't
  // support (mirrors the old DOM-based resolveAnchorInText: "a selection
  // that includes meaningful text from multiple blocks is rejected").
  if (to > block.sourceEnd && source.slice(block.sourceEnd, to).trim() !== "")
    return undefined;
  const clampedTo = Math.min(to, block.sourceEnd);
  const { plain, offsets, trusted } = buildPlainMap(
    source.slice(block.sourceStart, block.sourceEnd),
    block.sourceStart,
  );
  if (!trusted || plain !== block.text) return undefined;
  let start = -1;
  let end = -1;
  for (let i = 0; i < offsets.length; i += 1) {
    const at = offsets[i] ?? -1;
    if (start === -1 && at >= from) start = i;
    if (at < clampedTo) end = i + 1;
  }
  if (start === -1 || end <= start) return undefined;
  return { blockIndex: block.index, start, end };
}

// Resolve one (start, end) plain-offset pair — with the quote as a
// prefix/exact/suffix fallback when the offsets have drifted (exactSpans
// picks the right occurrence of a repeated phrase, not just the first) —
// against an already-built plain map. Used by blockAnchorsToSourceRanges,
// once per anchor, against the one parse it builds for the whole block.
function resolveInPlainMap(
  plain: string,
  offsets: readonly number[],
  start: number,
  end: number,
  quote: AnchorQuote,
): readonly [number, number] | undefined {
  if (start >= 0 && end > start && end <= offsets.length) {
    const from = offsets[start];
    const last = offsets[end - 1];
    if (from !== undefined && last !== undefined) return [from, last + 1];
  }
  const span = exactSpans(plain, quote)[0];
  if (span !== undefined) {
    const from = offsets[span[0]];
    const last = offsets[span[1] - 1];
    if (from !== undefined && last !== undefined) return [from, last + 1];
  }
  return undefined;
}

export type BlockAnchorRange = Readonly<{
  start: number;
  end: number;
  quote: AnchorQuote;
}>;

// Translate stored comment anchors (block + intra-block plain offsets, with
// the text quote as a fallback) back into source ranges [from, to) to paint
// as editor decorations, resolving every anchor for ONE block against a
// SINGLE parse of its source slice. `source` is the current editor document;
// when it's clean it shares the block's source coordinates. Prefers the
// offsets; when they've drifted, falls back to locating the quote by its
// prefix/exact/suffix context (via exactSpans) so a repeated phrase resolves
// to the right occurrence, not the first. Declines every anchor (all
// `undefined`) when the map is untrusted. Several open comment threads
// commonly anchor to the same block — resolving them together shares this
// one remark parse (buildPlainMap) instead of repeating it once per thread.
export function blockAnchorsToSourceRanges(
  block: AnchorBlock,
  source: string,
  anchors: readonly BlockAnchorRange[],
): readonly (readonly [number, number] | undefined)[] {
  const { plain, offsets, trusted } = buildPlainMap(
    source.slice(block.sourceStart, block.sourceEnd),
    block.sourceStart,
  );
  if (!trusted || plain !== block.text) return anchors.map(() => undefined);
  return anchors.map(({ start, end, quote }) =>
    resolveInPlainMap(plain, offsets, start, end, quote),
  );
}
