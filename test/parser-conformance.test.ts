import { markdownLanguage } from "@codemirror/lang-markdown";
import type { Heading } from "mdast";
import { describe, expect, it } from "vitest";

import { HEADING_LEVEL } from "../src/components/markdown/live-preview";
import { parseBlocks, processor } from "../src/store/domain/block-parse";
import { frontmatterLength } from "../src/store/domain/frontmatter";
import { compact } from "../src/util";

// Parser conformance: the editor and the reader see the same document.
//
// Corpus runs TWO structural markdown parsers by necessity (see AGENTS.md /
// the office-hours decision against a single Rust parser): lezer-markdown
// drives the CodeMirror live-preview (it must, for incremental editing), and
// remark/mdast drives both the rendered read view (react-markdown) and the
// block-anchor model (block-parse.ts). Two implementations of CommonMark+GFM
// can disagree on where a block begins or whether a line is a heading — and a
// disagreement is a real bug: a comment anchored to what the reader calls a
// heading would sit on what the editor renders as a paragraph. The
// frontmatter-as-Setext-heading issue was exactly this class.
//
// This test locks the two into agreement on the block DECOMPOSITION — the
// ordered sequence of block kinds, plus heading levels — for the constructs
// canonical documents actually use. It compares against the production
// `parseBlocks` (the remark side, the anchor model of record); the lezer side
// is walked here at the same granularity block-parse defines (list items and
// table rows are their own blocks; a blockquote is one coarse block;
// frontmatter is stripped first). A new divergence fails HERE, at the parser
// seam, instead of silently as a mis-anchored comment.

type Block = Readonly<{ kind: string; level?: number }>;

// mdast heading depths in document order, TOP-LEVEL only — matching
// parseBlocks, which emits a heading block for a top-level `heading` node and
// folds a heading nested in a blockquote into that one coarse quote block.
function remarkHeadingLevels(markdown: string): readonly number[] {
  const body = markdown.slice(frontmatterLength(markdown));
  const tree = processor.parse(body);
  return tree.children
    .filter((c): c is Heading => c.type === "heading")
    .map((h) => h.depth);
}

// The reader's decomposition: production block kinds, with heading levels
// zipped back in from the mdast walk (parseBlocks itself drops the level).
function remarkBlocks(markdown: string): readonly Block[] {
  const levels = remarkHeadingLevels(markdown);
  let h = 0;
  return parseBlocks(markdown).map((b) =>
    b.kind === "heading"
      ? // `level` is optional under exactOptionalPropertyTypes, so drop the
        // key when the mdast walk yielded no depth rather than setting it
        // to an explicit undefined (AGENTS.md: assemble with `compact()`).
        compact({ kind: b.kind, level: levels[h++] })
      : { kind: b.kind },
  );
}

// The editor's decomposition: walk the lezer tree at block-parse's granularity.
// Operates on a body string directly — callers pass the frontmatter-stripped
// body (the fence is a widget in the editor, metadata in the model, never a
// body block), so both sides parse the same text.
function lezerBlocksOf(body: string): readonly Block[] {
  const tree = markdownLanguage.parser.parse(body);
  const out: Block[] = [];

  type LNode = ReturnType<typeof tree.resolve>;
  const children = (node: LNode): LNode[] => {
    const kids: LNode[] = [];
    for (let c = node.firstChild; c !== null; c = c.nextSibling) kids.push(c);
    return kids;
  };

  // A list item is its own block; its own paragraph is folded into it, and
  // nested lists recurse into their items — exactly emitListItems.
  const emitList = (list: LNode): void => {
    for (const item of children(list)) {
      if (item.name !== "ListItem") continue;
      out.push({ kind: "list-item" });
      for (const sub of children(item)) {
        if (sub.name === "BulletList" || sub.name === "OrderedList") {
          emitList(sub);
        }
      }
    }
  };

  for (const node of children(tree.topNode)) {
    const level = HEADING_LEVEL[node.name];
    if (level !== undefined) {
      out.push({ kind: "heading", level });
      continue;
    }
    switch (node.name) {
      case "Paragraph":
        out.push({ kind: "paragraph" });
        break;
      case "FencedCode":
      case "CodeBlock":
        out.push({ kind: "code" });
        break;
      case "HTMLBlock":
      case "CommentBlock":
        out.push({ kind: "html" });
        break;
      case "Blockquote":
        out.push({ kind: "blockquote" });
        break;
      case "HorizontalRule":
        out.push({ kind: "thematic-break" });
        break;
      case "BulletList":
      case "OrderedList":
        emitList(node);
        break;
      case "Table":
        for (const row of children(node)) {
          if (row.name === "TableHeader" || row.name === "TableRow") {
            out.push({ kind: "table-row" });
          }
        }
        break;
      default:
        // LinkReference and other non-anchorable nodes: skipped both sides.
        break;
    }
  }
  return out;
}

// The full-document editor decomposition, frontmatter stripped to match the
// reader/anchor model (the fence is out-of-band metadata, not a body block).
function lezerBlocks(markdown: string): readonly Block[] {
  return lezerBlocksOf(markdown.slice(frontmatterLength(markdown)));
}

const FIXTURES: readonly (readonly [name: string, markdown: string])[] = [
  ["heading + paragraphs", "# Title\n\nFirst para.\n\nSecond para.\n"],
  [
    "all ATX heading levels",
    "# h1\n\n## h2\n\n### h3\n\n#### h4\n\n##### h5\n\n###### h6\n",
  ],
  ["setext headings", "Big Title\n=========\n\nSubtitle\n--------\n\nbody\n"],
  [
    "a fenced code block with a # inside is not a heading",
    "intro\n\n```ts\n# not a heading\nconst x = 1;\n```\n\nafter\n",
  ],
  [
    "thematic break separated by blank lines",
    "before\n\n---\n\nafter\n\n***\n\nlast\n",
  ],
  [
    "gfm table (header row + body rows)",
    "| Name | Role |\n| ---- | ---- |\n| Ada | Eng |\n| Grace | Ops |\n",
  ],
  [
    "task list with a nested bullet list",
    "- [ ] top item\n- [x] done item\n  - nested a\n  - nested b\n- last item\n",
  ],
  [
    "ordered list, nested",
    "1. one\n2. two\n   1. two-a\n   2. two-b\n3. three\n",
  ],
  [
    "multi-paragraph blockquote is one coarse block",
    "> first quoted para\n>\n> second quoted para\n\nafter the quote\n",
  ],
  ["html comment block", "before\n\n<!-- a comment -->\n\nafter\n"],
  [
    "frontmatter is stripped identically on both sides",
    "---\ntitle: Onboarding\ntags:\n  - ops\n---\n\n# Welcome\n\nBody paragraph.\n",
  ],
  [
    "mixed real-world document",
    [
      "# Runbook",
      "",
      "Intro paragraph with a [link](https://example.com).",
      "",
      "## Steps",
      "",
      "1. First",
      "2. Second",
      "",
      "> Note: be careful.",
      "",
      "| Env | URL |",
      "| --- | --- |",
      "| prod | x |",
      "",
      "```sh",
      "deploy --now",
      "```",
      "",
      "Done.",
    ].join("\n"),
  ],
];

describe("parser conformance: lezer (editor) vs remark (reader/anchor)", () => {
  for (const [name, markdown] of FIXTURES) {
    it(`agrees on the block decomposition — ${name}`, () => {
      const editor = lezerBlocks(markdown);
      const reader = remarkBlocks(markdown);
      // Print both sequences on failure so a divergence is legible.
      expect({ construct: name, editor }).toEqual({
        construct: name,
        editor: reader,
      });
    });
  }

  // Teeth: prove the comparators actually detect a divergence, so the green
  // above is meaningful. The historical bug — `title:` above a closing `---`
  // read as a Setext heading — only appears when frontmatter is NOT stripped.
  it("detects the raw-frontmatter Setext divergence (why the body is stripped)", () => {
    const doc = "---\ntitle: Hi\n---\n\nbody\n";
    // Reader/anchor model strips the fence: only the body paragraph remains.
    expect(remarkBlocks(doc)).toEqual([{ kind: "paragraph" }]);
    // Parsing the RAW document (no strip) the way the naive editor did, lezer
    // mis-reads the `title:` line as a Setext heading — a genuine divergence
    // the comparator catches, not a vacuous pass.
    const rawEditor = lezerBlocksOf(doc);
    expect(rawEditor).not.toEqual(remarkBlocks(doc));
    expect(rawEditor.some((b) => b.kind === "heading")).toBe(true);
    // Stripping the fence (what the body model does) restores agreement.
    expect(lezerBlocks(doc)).toEqual(remarkBlocks(doc));
  });
});
