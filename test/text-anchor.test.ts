import { describe, expect, it } from "vitest";

import {
  anchorSpansInText,
  type AnchorBlock,
  exactSpans,
  resolveAnchorInText,
} from "../src/lib/text-anchor";
import { MIN_ANCHOR_CHARS } from "../src/store/domain/anchor";

// Adjacent block elements concatenate in the rendered text with no
// separator, so the flat text of [A, B] is `A.text + B.text`.
const block = (index: number, text: string, id?: string): AnchorBlock =>
  id === undefined
    ? { index, text, sourceStart: 0, sourceEnd: text.length }
    : { id, index, text, sourceStart: 0, sourceEnd: text.length };

describe("resolveAnchorInText (selection → block + offset)", () => {
  it("anchors to the block the selection is in, even when text repeats", () => {
    // Two identical paragraphs; the selection lands in the SECOND.
    const blocks = [block(0, "the cat sat"), block(1, "the cat sat")];
    const full = "the cat satthe cat sat";
    // Full text of the second block: offset 11..22.
    expect(resolveAnchorInText(full, 11, 22, blocks)).toEqual({
      blockIndex: 1,
      start: 0,
      end: 11,
      exact: "the cat sat",
      sourceStart: 0,
      sourceEnd: 11,
    });
  });

  it("anchors to the first block when the selection is in it", () => {
    const blocks = [block(0, "the cat sat"), block(1, "the cat sat")];
    const full = "the cat satthe cat sat";
    expect(resolveAnchorInText(full, 0, 11, blocks)).toMatchObject({
      blockIndex: 0,
      start: 0,
      end: 11,
      exact: "the cat sat",
    });
  });

  it("picks the selected occurrence of a phrase repeated WITHIN a block", () => {
    const blocks = [block(0, "alpha beta alpha beta")];
    const full = "alpha beta alpha beta";
    // The second "alpha beta" is at offset 11..21.
    expect(resolveAnchorInText(full, 11, 21, blocks)).toMatchObject({
      blockIndex: 0,
      start: 11,
      end: 21,
      exact: "alpha beta",
    });
  });

  it("returns undefined for an empty selection", () => {
    expect(resolveAnchorInText("abc", 1, 1, [block(0, "abc")])).toBeUndefined();
  });

  it("returns undefined for a short selection", () => {
    const text = "short text";
    expect(
      resolveAnchorInText(text, 0, MIN_ANCHOR_CHARS - 1, [block(0, text)]),
    ).toBeUndefined();
  });

  it("returns undefined for a selection crossing block boundaries", () => {
    const blocks = [block(0, "first block"), block(1, "second block")];
    const full = "first blocksecond block";
    expect(resolveAnchorInText(full, 6, 14, blocks)).toBeUndefined();
  });

  it("clamps browser-added trailing whitespace from paragraph selection", () => {
    const paragraph =
      "A monthly comfort subscription. Each kit pairs one paperback novel\nships the first Tuesday.";
    const blocks = [
      block(0, "Marlow"),
      block(1, paragraph),
      block(2, "Who it's for"),
    ];
    const full = `Marlow\n${paragraph}\nWho it's for`;
    const start = "Marlow\n".length;
    const end = start + paragraph.length + 1;
    expect(resolveAnchorInText(full, start, end, blocks)).toEqual({
      blockIndex: 1,
      start: 0,
      end: paragraph.length,
      exact: paragraph,
      sourceStart: 0,
      sourceEnd: paragraph.length,
    });
  });

  it("clamps browser-added leading whitespace from paragraph selection", () => {
    const blocks = [block(0, "first"), block(1, "second para")];
    const full = "first\nsecond para";
    expect(resolveAnchorInText(full, 5, full.length, blocks)).toMatchObject({
      blockIndex: 1,
      start: 0,
      end: "second para".length,
      exact: "second para",
    });
  });

  it("skips a block whose text isn't present verbatim, never misattributing", () => {
    // A table row's block text carries `|` separators the rendered cells
    // drop, so it isn't found in `full` — it must be skipped, not matched.
    const blocks = [block(0, "a | b"), block(1, "tail para")];
    const full = "abtail para";
    expect(resolveAnchorInText(full, 2, 11, blocks)).toMatchObject({
      blockIndex: 1,
      exact: "tail para",
    });
    // A selection over the unaligned row resolves to nothing, not block 0.
    expect(resolveAnchorInText(full, 0, 2, blocks)).toBeUndefined();
  });
});

describe("exactSpans (quote → highlighted occurrence)", () => {
  it("highlights the occurrence matching the quote's context, not the first", () => {
    const full = "see foo here and foo there";
    // The SECOND foo, bracketed by its real neighbours.
    expect(
      exactSpans(full, { prefix: "and ", exact: "foo", suffix: " there" }),
    ).toEqual([[17, 20]]);
  });

  it("returns no span for an empty quote", () => {
    expect(
      exactSpans("anything", { prefix: "", exact: "", suffix: "" }),
    ).toEqual([]);
  });

  it("returns no span when the bracketed quote drifted out of the text", () => {
    expect(
      exactSpans("the text changed", {
        prefix: "old ",
        exact: "phrase",
        suffix: " gone",
      }),
    ).toEqual([]);
  });

  it("returns every occurrence that shares identical quote-only context", () => {
    const full = "x ab y x ab y";
    expect(
      exactSpans(full, { prefix: "x ", exact: "ab", suffix: " y" }),
    ).toEqual([
      [2, 4],
      [9, 11],
    ]);
  });
});

describe("anchorSpansInText (stored anchor → highlighted occurrence)", () => {
  it("uses the stable block id to disambiguate identical quote context", () => {
    const blocks = [block(0, "x ab y", "a"), block(1, "x ab y", "b")];
    const full = "x ab yx ab y";
    expect(
      anchorSpansInText(full, blocks, [
        {
          blockId: "b",
          start: 2,
          end: 4,
          quote: { prefix: "x ", exact: "ab", suffix: " y" },
        },
      ]),
    ).toEqual([[8, 10]]);
  });

  it("falls back to quote context when the block id is unavailable", () => {
    const blocks = [block(0, "see foo here"), block(1, "and foo there")];
    const full = "see foo hereand foo there";
    expect(
      anchorSpansInText(full, blocks, [
        {
          blockId: "missing",
          start: 4,
          end: 7,
          quote: { prefix: "and ", exact: "foo", suffix: " there" },
        },
      ]),
    ).toEqual([[16, 19]]);
  });
});
