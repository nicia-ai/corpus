import { parseBlocksWithRanges } from "@nicia-ai/prose-diff";
import { describe, expect, it } from "vitest";

import {
  blockAnchorsToSourceRanges,
  sourceRangeToBlockAnchor,
} from "../src/lib/block-offsets";
import type { AnchorBlock } from "../src/lib/text-anchor";

// Build the blocks the editor would hand the adapter, from real parsed block
// ranges (so source offsets are exactly what the block model uses).
function blocksOf(markdown: string): readonly AnchorBlock[] {
  return parseBlocksWithRanges(markdown).map((b, index) => ({
    index,
    text: b.text,
    sourceStart: b.sourceStart,
    sourceEnd: b.sourceEnd,
  }));
}

function expectDefined<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`expected ${label} to be defined`);
  return value;
}

// Map a visible selection given by the source substring `sourceSel` to the
// plain quote the resulting anchor would store.
function quoteFor(markdown: string, sourceSel: string): string | undefined {
  const blocks = blocksOf(markdown);
  const from = markdown.indexOf(sourceSel);
  const anchor = sourceRangeToBlockAnchor(
    blocks,
    markdown,
    from,
    from + sourceSel.length,
  );
  if (anchor === undefined) return undefined;
  return blocks[anchor.blockIndex]?.text.slice(anchor.start, anchor.end);
}

describe("sourceRangeToBlockAnchor", () => {
  it("maps a plain-paragraph selection 1:1", () => {
    expect(quoteFor("The quick brown fox jumps.", "quick brown")).toBe(
      "quick brown",
    );
  });

  it("drops the heading marker from the plain offsets", () => {
    const md = "## Hello world";
    const blocks = blocksOf(md);
    const from = md.indexOf("Hello");
    const anchor = sourceRangeToBlockAnchor(blocks, md, from, from + 11);
    expect(anchor).toEqual({ blockIndex: 0, start: 0, end: 11 });
    expect(blocks[0]?.text).toBe("Hello world");
  });

  it("snaps to the visible text inside emphasis markers", () => {
    expect(quoteFor("This is **important** text.", "important")).toBe(
      "important",
    );
  });

  it("ignores hidden markers when the selection starts on them", () => {
    // Selection that begins on the opening `**` still anchors to "important".
    expect(quoteFor("This is **important** text.", "**important**")).toBe(
      "important",
    );
  });

  it("maps a link's visible text, not its URL", () => {
    expect(quoteFor("See [the docs](https://x.dev) now.", "the docs")).toBe(
      "the docs",
    );
  });

  it("maps inside a list item", () => {
    expect(quoteFor("- first item here", "item here")).toBe("item here");
  });

  it("returns undefined for an empty or inverted range", () => {
    const md = "Some ordinary text here.";
    const blocks = blocksOf(md);
    expect(sourceRangeToBlockAnchor(blocks, md, 5, 5)).toBeUndefined();
    expect(sourceRangeToBlockAnchor(blocks, md, 8, 5)).toBeUndefined();
  });

  it("declines a table row (plain text can't be reproduced)", () => {
    const md = "| a | b |\n| - | - |\n| one | two |";
    const blocks = blocksOf(md);
    const from = md.indexOf("one");
    expect(
      sourceRangeToBlockAnchor(blocks, md, from, from + 3),
    ).toBeUndefined();
  });

  it("declines a block with a backslash escape rather than mis-anchoring", () => {
    // Source is longer than the decoded text (\\* -> *), so a 1:1 map would
    // drift; the adapter must decline, not anchor to shifted characters.
    expect(quoteFor("Use the \\* operator carefully now.", "operator")).toBe(
      undefined,
    );
  });

  it("maps the visible text of a block containing an inline image", () => {
    expect(quoteFor("See ![logo](x.png) here now.", "here now")).toBe(
      "here now",
    );
  });

  it("rejects a selection that crosses into the next block's text", () => {
    const md = "First paragraph here.\n\nSecond paragraph continues.";
    const blocks = blocksOf(md);
    const from = md.indexOf("here");
    const to = md.indexOf("continues") + "continues".length;
    expect(sourceRangeToBlockAnchor(blocks, md, from, to)).toBeUndefined();
  });

  it("still clamps a selection that only overruns into blank space", () => {
    const md = "First paragraph here.\n\nSecond paragraph.";
    const blocks = blocksOf(md);
    const from = md.indexOf("here");
    // Overshoot past the block's end into the blank line that separates it
    // from the next block, but not into the next block's own text.
    const to = md.indexOf("\n\nSecond") + 1;
    const anchor = expectDefined(
      sourceRangeToBlockAnchor(blocks, md, from, to),
      "anchor",
    );
    expect(
      blocks[anchor.blockIndex]?.text.slice(anchor.start, anchor.end),
    ).toBe("here.");
  });

  it("maps inside a list item with two own paragraphs (multi-child own text)", () => {
    const md = "- First paragraph.\n\n  Second paragraph.\n";
    const blocks = blocksOf(md);
    expect(blocks[0]?.text).toBe("First paragraph.\nSecond paragraph.");
    expect(quoteFor(md, "Second paragraph")).toBe("Second paragraph");
  });

  it("maps inside a list item whose second child is an indented fenced code block", () => {
    const md = "- Run the build\n\n  ```bash\n  make build\n  ```\n";
    const blocks = blocksOf(md);
    expect(blocks[0]?.text).toBe("Run the build\nmake build");
    expect(quoteFor(md, "Run the build")).toBe("Run the build");
  });
});

describe("blockAnchorsToSourceRanges", () => {
  it("round-trips a bold selection back to its source span", () => {
    const md = "This is **important** text.";
    const blocks = blocksOf(md);
    const from = md.indexOf("important");
    const anchor = expectDefined(
      sourceRangeToBlockAnchor(blocks, md, from, from + 9),
      "anchor",
    );
    const block = expectDefined(blocks[anchor.blockIndex], "block");
    const [range] = blockAnchorsToSourceRanges(block, md, [
      {
        start: anchor.start,
        end: anchor.end,
        quote: {
          prefix: "",
          exact: block.text.slice(anchor.start, anchor.end),
          suffix: "",
        },
      },
    ]);
    expect(md.slice(...expectDefined(range, "range"))).toBe("important");
  });

  it("falls back to the quote when offsets are out of range", () => {
    const md = "The quick brown fox jumps.";
    const block = expectDefined(blocksOf(md)[0], "block");
    const [range] = blockAnchorsToSourceRanges(block, md, [
      {
        start: 999,
        end: 1000,
        quote: { prefix: "quick ", exact: "brown fox", suffix: " jumps" },
      },
    ]);
    expect(md.slice(...expectDefined(range, "range"))).toBe("brown fox");
  });

  it("resolves multiple anchors on the same block, in anchor order", () => {
    const md = "The quick brown fox jumps over the lazy dog.";
    const block = expectDefined(blocksOf(md)[0], "block");
    const anchorFor = (
      text: string,
    ): {
      start: number;
      end: number;
      quote: { prefix: string; exact: string; suffix: string };
    } => {
      const start = block.text.indexOf(text);
      return {
        start,
        end: start + text.length,
        quote: { prefix: "", exact: text, suffix: "" },
      };
    };
    const anchors = [
      anchorFor("quick"),
      anchorFor("brown fox"),
      anchorFor("dog"),
    ];
    const ranges = blockAnchorsToSourceRanges(block, md, anchors);
    expect(ranges.map((r) => (r ? md.slice(r[0], r[1]) : undefined))).toEqual([
      "quick",
      "brown fox",
      "dog",
    ]);
  });

  it("declines every anchor when the block can't be trusted (table row)", () => {
    const md = "| a | b |\n| - | - |\n| one | two |";
    const block = expectDefined(blocksOf(md)[1], "block");
    const ranges = blockAnchorsToSourceRanges(block, md, [
      { start: 0, end: 3, quote: { prefix: "", exact: "one", suffix: "" } },
      { start: 4, end: 7, quote: { prefix: "", exact: "two", suffix: "" } },
    ]);
    expect(ranges).toEqual([undefined, undefined]);
  });
});
