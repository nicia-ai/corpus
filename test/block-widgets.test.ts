import { markdownLanguage } from "@codemirror/lang-markdown";
import { describe, expect, it } from "vitest";

import {
  type TableModel,
  tableModelFromTree,
} from "@/components/markdown/block-widgets";
import { type InlineSpan, spanText } from "@/components/markdown/inline-spans";

// The table widget's model is walked from the SAME Lezer tree the editor
// parses, and must agree with remark-gfm (the read view's renderer for the
// same document): inline markdown renders inside cells, a backslash-escaped
// `|` is literal cell content, an empty interior cell keeps its column.
// Tests parse standalone table sources with the editor's own language.

function model(src: string): TableModel | undefined {
  const table = markdownLanguage.parser.parse(src).topNode.getChild("Table");
  if (table === null) return undefined;
  return tableModelFromTree((from, to) => src.slice(from, to), table);
}

function texts(cells: readonly (readonly InlineSpan[])[]): string[] {
  return cells.map(spanText);
}

describe("tableModelFromTree", () => {
  it("splits ordinary rows on unescaped pipes", () => {
    const m = model("| a | b |\n| - | - |\n| one | two |");
    expect(texts(m?.header ?? [])).toEqual(["a", "b"]);
    expect((m?.rows ?? []).map(texts)).toEqual([["one", "two"]]);
  });

  it("keeps a backslash-escaped pipe as literal cell content", () => {
    const m = model("| a | b |\n| - | - |\n| one\\|two | three |");
    expect((m?.rows ?? []).map(texts)).toEqual([["one|two", "three"]]);
  });

  it("preserves a genuinely empty interior cell's column", () => {
    const m = model("| a | b | c |\n| - | - | - |\n| one || two |");
    expect((m?.rows ?? []).map(texts)).toEqual([["one", "", "two"]]);
  });

  it("parses column alignments from the delimiter line", () => {
    const m = model("| a | b | c |\n| :-: | ---: | --- |\n| x | y | z |");
    expect(m?.aligns).toEqual(["center", "right", ""]);
  });

  it("renders strong emphasis as a span, not literal asterisks", () => {
    const m = model("| a |\n| - |\n| **Milestone Name** |");
    const cell = m?.rows[0]?.[0] ?? [];
    expect(cell).toEqual([
      { kind: "strong", children: [{ kind: "text", text: "Milestone Name" }] },
    ]);
    expect(spanText(cell)).toBe("Milestone Name");
  });

  it("renders inline code, strikethrough, and emphasis inside one cell", () => {
    const m = model("| a |\n| - |\n| run `pnpm check` then ~~skip~~ *ship* |");
    const cell = m?.rows[0]?.[0] ?? [];
    expect(cell).toEqual([
      { kind: "text", text: "run " },
      { kind: "code", text: "pnpm check" },
      { kind: "text", text: " then " },
      { kind: "del", children: [{ kind: "text", text: "skip" }] },
      { kind: "text", text: " " },
      { kind: "em", children: [{ kind: "text", text: "ship" }] },
    ]);
  });

  it("renders a destination link with href and label", () => {
    const m = model("| a |\n| - |\n| see [the spec](spec.md 't') here |");
    const cell = m?.rows[0]?.[0] ?? [];
    expect(cell).toEqual([
      { kind: "text", text: "see " },
      {
        kind: "link",
        href: "spec.md",
        children: [{ kind: "text", text: "the spec" }],
      },
      { kind: "text", text: " here" },
    ]);
  });

  it("keeps a bracket-only reference literal, brackets included", () => {
    const m = model("| a |\n| - |\n| a [shortcut ref] stays |");
    expect(spanText(m?.rows[0]?.[0] ?? [])).toBe("a [shortcut ref] stays");
  });

  it("keeps a wikilink literal without a resolver", () => {
    const m = model("| a |\n| - |\n| see [[brand-voice]] |");
    expect(spanText(m?.rows[0]?.[0] ?? [])).toBe("see [[brand-voice]]");
  });

  it("renders a resolved wikilink as a link, consuming the brackets", () => {
    const src = "| a |\n| - |\n| see [[brand-voice\\|Voice]] and [[gone]] |";
    const table = markdownLanguage.parser.parse(src).topNode.getChild("Table");
    const wiki = (target: string): string | undefined =>
      target === "brand-voice" ? "guides-brand-voice" : undefined;
    expect(table).not.toBeNull();
    if (table === null) return;
    const m = tableModelFromTree((f, t) => src.slice(f, t), table, wiki);
    expect(m?.rows[0]?.[0]).toEqual([
      { kind: "text", text: "see " },
      {
        kind: "link",
        href: "guides-brand-voice",
        children: [{ kind: "text", text: "Voice" }],
      },
      { kind: "text", text: " and [[gone]]" },
    ]);
  });

  it("renders emphasis nested inside a link label", () => {
    const m = model("| a |\n| - |\n| [**bold** label](x.md) |");
    const cell = m?.rows[0]?.[0] ?? [];
    expect(cell).toEqual([
      {
        kind: "link",
        href: "x.md",
        children: [
          { kind: "strong", children: [{ kind: "text", text: "bold" }] },
          { kind: "text", text: " label" },
        ],
      },
    ]);
  });

  it("renders an image as an image span with src and alt", () => {
    const m = model("| a |\n| - |\n| ![journey](assets/j.png) |");
    expect(m?.rows[0]?.[0]).toEqual([
      { kind: "image", src: "assets/j.png", alt: "journey" },
    ]);
  });

  it("leaves a ragged short row's missing columns empty at render", () => {
    const m = model("| a | b |\n| - | - |\n| only |");
    expect(texts(m?.rows[0] ?? [])).toEqual(["only"]);
  });

  it("returns undefined for a non-table source", () => {
    expect(model("just a paragraph")).toBeUndefined();
  });
});
