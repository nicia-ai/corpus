import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { asBlockId, type BlockId } from "../src/ids";
import {
  type Block,
  matchBlocks,
  type NextBlock,
} from "../src/store/domain/block-match";
import {
  parseBlocks,
  parseBlocksWithRanges,
} from "../src/store/domain/block-parse";

const kt = (
  blocks: readonly NextBlock[],
): readonly (readonly [string, string])[] =>
  blocks.map((b) => [b.kind, b.text] as const);

function minter(): () => BlockId {
  let n = 0;
  return () => asBlockId(`mint-${(n += 1).toString()}`);
}

// --- decomposition (documents the granularity) ------------------------

describe("parseBlocks decomposition", () => {
  it("splits headings and paragraphs", () => {
    expect(kt(parseBlocks("# Title\n\nFirst para.\n\nSecond para."))).toEqual([
      ["heading", "Title"],
      ["paragraph", "First para."],
      ["paragraph", "Second para."],
    ]);
  });

  it("emits one block per list item, including nested items (list-item granularity)", () => {
    expect(kt(parseBlocks("- one\n  - one a\n  - one b\n- two"))).toEqual([
      ["list-item", "one"],
      ["list-item", "one a"],
      ["list-item", "one b"],
      ["list-item", "two"],
    ]);
  });

  it("emits one block per table row (header included)", () => {
    expect(kt(parseBlocks("| A | B |\n| - | - |\n| 1 | 2 |"))).toEqual([
      ["table-row", "A | B"],
      ["table-row", "1 | 2"],
    ]);
  });

  it("keeps a fenced code block intact with its newlines", () => {
    expect(kt(parseBlocks("```js\nconst x = 1;\nconst y = 2;\n```"))).toEqual([
      ["code", "const x = 1;\nconst y = 2;"],
    ]);
  });

  it("treats a blockquote as one coarse block", () => {
    const blocks = parseBlocks("> line one\n> line two");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("blockquote");
  });

  it("emits a raw HTML block verbatim", () => {
    expect(kt(parseBlocks('a\n\n<div class="note">hi</div>\n\nb'))).toEqual([
      ["paragraph", "a"],
      ["html", '<div class="note">hi</div>'],
      ["paragraph", "b"],
    ]);
  });

  it("treats a mid-document --- as a thematic break, not frontmatter", () => {
    expect(kt(parseBlocks("a\n\n---\n\nb"))).toEqual([
      ["paragraph", "a"],
      ["thematic-break", ""],
      ["paragraph", "b"],
    ]);
  });

  it("strips a leading frontmatter fence (metadata, not a block)", () => {
    expect(kt(parseBlocks("---\ntitle: Hi\n---\n\n# Heading\n\nbody"))).toEqual(
      [
        ["heading", "Heading"],
        ["paragraph", "body"],
      ],
    );
  });

  it("returns no blocks for an empty document", () => {
    expect(parseBlocks("")).toEqual([]);
    expect(parseBlocks("   \n\n  ")).toEqual([]);
  });

  it("exposes source ranges that slice back to each block's source", () => {
    const md = "# Title\n\nFirst para.\n\n- one\n- two";
    for (const b of parseBlocksWithRanges(md)) {
      const slice = md.slice(b.sourceStart, b.sourceEnd);
      for (const w of b.text.split(/\s+/).filter(Boolean)) {
        expect(slice).toContain(w);
      }
    }
  });

  it("source ranges account for stripped frontmatter", () => {
    const md = "---\ntitle: X\n---\n\n# Heading\n\nbody text";
    const heading = parseBlocksWithRanges(md).find((b) => b.kind === "heading");
    expect(heading).toBeDefined();
    if (heading) {
      expect(md.slice(heading.sourceStart, heading.sourceEnd)).toBe(
        "# Heading",
      );
    }
  });
});

// --- stability --------------------------------------------------------

describe("parseBlocks stability", () => {
  it("is deterministic", () => {
    const md =
      "# A\n\nbody one\n\n- x\n  - y\n\n| h |\n| - |\n| v |\n\n> quote";
    expect(parseBlocks(md)).toEqual(parseBlocks(md));
  });

  it("never throws on arbitrary input (totality)", () => {
    const markdownish = fc
      .array(
        fc.constantFrom(
          "#",
          "## ",
          "- ",
          "* ",
          "\n",
          "\n\n",
          "`",
          "```",
          "|",
          "> ",
          "---",
          "text ",
          "  ",
          "\t",
        ),
        { maxLength: 40 },
      )
      .map((parts) => parts.join(""));
    fc.assert(
      fc.property(fc.oneof(fc.string(), markdownish), (s) => {
        expect(Array.isArray(parseBlocks(s))).toBe(true);
      }),
      { numRuns: 400, seed: 20260607 },
    );
  });
});

// --- parse → match end-to-end on real markdown ------------------------
// Closes the gap the matcher prototype left open ("no real parser yet"):
// structural edits to a real markdown document, re-parsed, must let the
// matcher recover every surviving block — including moves.

type SpecKind = "para" | "heading" | "item";
type Spec = Readonly<{ id: number; kind: SpecKind }>;

// Each spec renders to a single globally-unique token, so this property
// isolates STRUCTURAL edits: distinct blocks never share content, the
// fuzzy similarity tier never fires, and any carry must be the exact tier
// correctly following a survivor. (The fuzzy tier's prose-conflation is
// exercised separately in block-match.test.ts.)
function renderSpec(s: Spec): string {
  const tok = `tok${s.id.toString()}`;
  switch (s.kind) {
    case "para":
      return tok;
    case "heading":
      return `## ${tok}`;
    case "item":
      return `- ${tok}`;
  }
}

// Blank-line separation guarantees one block per spec, in order, whatever
// the kind sequence — so block index lines up with spec index.
const renderDoc = (specs: readonly Spec[]): string =>
  specs.map(renderSpec).join("\n\n");

type SpecOp = Readonly<
  | { kind: "insert"; pos: number; specKind: SpecKind }
  | { kind: "delete"; pos: number }
  | { kind: "move"; from: number; to: number }
>;

const specOp: fc.Arbitrary<SpecOp> = fc.oneof(
  fc.record({
    kind: fc.constant("insert"),
    pos: fc.nat(20),
    specKind: fc.constantFrom<SpecKind>("para", "heading", "item"),
  }),
  fc.record({ kind: fc.constant("delete"), pos: fc.nat(20) }),
  fc.record({ kind: fc.constant("move"), from: fc.nat(20), to: fc.nat(20) }),
);

describe("parseBlocks → matchBlocks (property)", () => {
  it("recovers every surviving block across moves/inserts/deletes of real markdown", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<SpecKind>("para", "heading", "item"), {
          minLength: 1,
          maxLength: 6,
        }),
        fc.array(specOp, { minLength: 0, maxLength: 12 }),
        (baseKinds, ops) => {
          let nextId = 0;
          const base: Spec[] = baseKinds.map((kind) => ({
            id: nextId++,
            kind,
          }));
          const work = [...base];
          for (const op of ops) {
            if (op.kind === "insert") {
              work.splice(Math.min(op.pos, work.length), 0, {
                id: nextId++,
                kind: op.specKind,
              });
            } else if (op.kind === "delete" && work.length > 0) {
              work.splice(op.pos % work.length, 1);
            } else if (op.kind === "move" && work.length > 1) {
              const removed = work.splice(op.from % work.length, 1);
              const m = removed[0];
              if (m !== undefined) work.splice(op.to % (work.length + 1), 0, m);
            }
          }

          const baseBlocks = parseBlocks(renderDoc(base));
          const nextBlocks = parseBlocks(renderDoc(work));
          // one block per spec, in order
          expect(baseBlocks).toHaveLength(base.length);
          expect(nextBlocks).toHaveLength(work.length);

          const prevBlocks: Block[] = base.map((s, i) => {
            const b = baseBlocks[i];
            if (b === undefined) throw new Error("spec/block mismatch");
            return {
              id: asBlockId(`b${s.id.toString()}`),
              kind: b.kind,
              text: b.text,
            };
          });

          const r = matchBlocks({
            prev: prevBlocks,
            next: nextBlocks,
            mintId: minter(),
          });

          const baseIds = new Set(base.map((s) => s.id));
          work.forEach((s, j) => {
            const block = r.blocks[j];
            if (baseIds.has(s.id)) {
              expect(block?.id).toBe(asBlockId(`b${s.id.toString()}`));
              expect(block?.origin.status).toBe("unchanged");
            } else {
              expect(block?.origin.status).toBe("inserted");
            }
          });

          const survived = new Set(work.map((s) => s.id));
          const expectedDeleted = base
            .filter((s) => !survived.has(s.id))
            .map((s) => asBlockId(`b${s.id.toString()}`));
          expect(new Set(r.deleted)).toEqual(new Set(expectedDeleted));
        },
      ),
      { numRuns: 300, seed: 20260607 },
    );
  });

  it("does not conflate boilerplate-sharing paragraphs end-to-end (idf upgrade)", () => {
    // Real markdown where every paragraph shares 'shared common words' but
    // has a distinctive lead. Plain Jaccard scored the deleted/inserted pair
    // ~0.6 and merged them; idf weighting keeps them apart.
    const base = [
      "alpha1 bravo1 shared common words",
      "alpha2 bravo2 shared common words",
      "alpha3 bravo3 shared common words",
    ];
    const edited = [
      "alpha1 bravo1 shared common words",
      "alpha9 bravo9 shared common words", // middle paragraph replaced
      "alpha3 bravo3 shared common words",
    ];
    const baseBlocks = parseBlocks(base.join("\n\n"));
    const nextBlocks = parseBlocks(edited.join("\n\n"));
    const prevBlocks: Block[] = baseBlocks.map((b, i) => ({
      id: asBlockId(`b${i.toString()}`),
      kind: b.kind,
      text: b.text,
    }));
    const r = matchBlocks({
      prev: prevBlocks,
      next: nextBlocks,
      mintId: minter(),
    });

    expect(r.deleted).toEqual([asBlockId("b1")]);
    expect(r.blocks[0]?.id).toBe(asBlockId("b0"));
    expect(r.blocks[2]?.id).toBe(asBlockId("b2"));
    expect(r.blocks[1]?.origin.status).toBe("inserted");
  });
});
