import { describe, expect, it } from "vitest";

import { parseTable } from "@/components/markdown/block-widgets";

// parseTable/splitRow must agree with remark-gfm's cell splitting (the read
// view's renderer for the same document) — including honoring a
// backslash-escaped `|` as literal cell content, not a column separator.

describe("parseTable", () => {
  it("splits ordinary rows on unescaped pipes", () => {
    const model = parseTable("| a | b |\n| - | - |\n| one | two |");
    expect(model?.header).toEqual(["a", "b"]);
    expect(model?.rows).toEqual([["one", "two"]]);
  });

  it("keeps a backslash-escaped pipe as literal cell content", () => {
    const model = parseTable("| a | b |\n| - | - |\n| one\\|two | three |");
    expect(model?.header).toEqual(["a", "b"]);
    expect(model?.rows).toEqual([["one|two", "three"]]);
  });

  it("preserves a genuinely empty interior cell", () => {
    const model = parseTable("| a | b |\n| - | - |\n| one || two |");
    expect(model?.rows).toEqual([["one", "", "two"]]);
  });
});
