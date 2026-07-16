import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  applyHunks,
  diffToHunks,
  type Hunk,
} from "../src/store/domain/suggestion";

const PROPERTY_RUNS = { numRuns: 300, seed: 20260607 } as const;

type RenderKind = "paragraph" | "heading" | "list-item" | "code";

type BlockSpec = Readonly<{
  id: number;
  kind: RenderKind;
  revision: number;
}>;

type EditOp = Readonly<
  | { kind: "insert"; pos: number; blockKind: RenderKind }
  | { kind: "delete"; pos: number }
  | { kind: "replace"; pos: number; blockKind: RenderKind }
>;

type Scenario = Readonly<{
  base: string;
  proposed: string;
}>;

const renderKindArb = fc.constantFrom<RenderKind>(
  "paragraph",
  "heading",
  "list-item",
  "code",
);

const editOpArb: fc.Arbitrary<EditOp> = fc.oneof(
  fc.record({
    kind: fc.constant("insert"),
    pos: fc.nat(20),
    blockKind: renderKindArb,
  }),
  fc.record({ kind: fc.constant("delete"), pos: fc.nat(20) }),
  fc.record({
    kind: fc.constant("replace"),
    pos: fc.nat(20),
    blockKind: renderKindArb,
  }),
);

const baseKindsArb = fc.array(renderKindArb, {
  minLength: 1,
  maxLength: 8,
});

const editSequenceArb = fc.array(editOpArb, { minLength: 0, maxLength: 12 });

const scenarioArb = fc
  .record({
    baseKinds: baseKindsArb,
    ops: editSequenceArb,
  })
  .map(({ baseKinds, ops }) => buildScenario(baseKinds, ops));

function buildScenario(
  baseKinds: readonly RenderKind[],
  ops: readonly EditOp[],
): Scenario {
  let nextId = 0;
  const base: BlockSpec[] = baseKinds.map((kind) => ({
    id: nextId++,
    kind,
    revision: 0,
  }));
  const work: BlockSpec[] = [...base];

  for (const op of ops) {
    if (op.kind === "insert") {
      work.splice(Math.min(op.pos, work.length), 0, {
        id: nextId++,
        kind: op.blockKind,
        revision: 0,
      });
    } else if (op.kind === "delete" && work.length > 0) {
      work.splice(op.pos % work.length, 1);
    } else if (op.kind === "replace" && work.length > 0) {
      const index = op.pos % work.length;
      const current = work[index];
      if (current !== undefined) {
        work[index] = {
          id: current.id,
          kind: op.blockKind,
          revision: current.revision + 1,
        };
      }
    }
  }

  return {
    base: renderDoc(base),
    proposed: renderDoc(work),
  };
}

// Consecutive list items join TIGHT ("\n") — the separator shape the 2026-07-16
// dogfood found applyHunks destroying; everything else joins loose ("\n\n").
// Both documents render under the same rule, so the separator between two
// UNCHANGED neighbors is identical on both sides and byte-exact round-trips
// are a fair expectation.
function renderDoc(blocks: readonly BlockSpec[]): string {
  let out = "";
  blocks.forEach((block, i) => {
    if (i > 0) {
      const prev = blocks[i - 1];
      out +=
        prev?.kind === "list-item" && block.kind === "list-item"
          ? "\n"
          : "\n\n";
    }
    out += renderBlock(block);
  });
  return out;
}

function blockText(block: BlockSpec): string {
  return [
    `block${block.id.toString()}`,
    `stable${block.id.toString()}`,
    `rev${block.revision.toString()}`,
    `marker${block.id.toString()}`,
    `kind-${block.kind}`,
  ].join(" ");
}

function renderBlock(block: BlockSpec): string {
  const text = blockText(block);
  switch (block.kind) {
    case "paragraph":
      return text;
    case "heading":
      return `## ${text}`;
    case "list-item":
      return `- ${text}`;
    case "code":
      return ["```txt", text, "", `${text} code-tail`, "```"].join("\n");
  }
}

function subsetByMask(
  hunks: readonly Hunk[],
  mask: readonly boolean[],
): readonly Hunk[] {
  return hunks.filter((_, index) => mask[index % mask.length] ?? false);
}

describe("suggestion hunks (property)", () => {
  it("accept-all reproduces the proposed markdown byte-for-byte", () => {
    fc.assert(
      fc.property(scenarioArb, ({ base, proposed }) => {
        const hunks = diffToHunks(base, proposed);
        expect(applyHunks(base, hunks)).toBe(proposed);
      }),
      PROPERTY_RUNS,
    );
  });

  it("apply-none leaves a normalized suggestion document unchanged", () => {
    fc.assert(
      fc.property(scenarioArb, ({ base }) => {
        expect(applyHunks(base, [])).toBe(base);
      }),
      PROPERTY_RUNS,
    );
  });

  it("any accepted subset is well-formed, with empty and full subsets pinned", () => {
    fc.assert(
      fc.property(
        scenarioArb,
        fc.array(fc.boolean(), { maxLength: 24 }),
        ({ base, proposed }, mask) => {
          const hunks = diffToHunks(base, proposed);
          const subset = subsetByMask(hunks, mask);

          const applied = applyHunks(base, subset);
          expect(applyHunks(base, [])).toBe(base);
          expect(applyHunks(base, hunks)).toBe(proposed);
          // Content fidelity under ANY decision mix: every accepted
          // insert/replace body lands verbatim; an accepted delete removes
          // its block; a skipped delete keeps it (block texts are unique by
          // construction, so containment is a faithful check).
          const acceptedSet = new Set(subset);
          for (const h of hunks) {
            if (h.op !== "delete") {
              if (acceptedSet.has(h)) {
                expect(applied).toContain(h.proposedText);
              }
            } else {
              const blockText = base.slice(h.baseStart, h.baseEnd);
              if (acceptedSet.has(h)) {
                expect(applied).not.toContain(blockText);
              } else {
                expect(applied).toContain(blockText);
              }
            }
          }
        },
      ),
      PROPERTY_RUNS,
    );
  });

  it("application is independent of hunk input order", () => {
    fc.assert(
      fc.property(scenarioArb, ({ base, proposed }) => {
        const hunks = diffToHunks(base, proposed);
        const reversed = [...hunks].reverse();

        expect(applyHunks(base, reversed)).toBe(applyHunks(base, hunks));
      }),
      PROPERTY_RUNS,
    );
  });

  it("no-op proposals produce no hunks", () => {
    fc.assert(
      fc.property(scenarioArb, ({ base }) => {
        expect(diffToHunks(base, base)).toEqual([]);
      }),
      PROPERTY_RUNS,
    );
  });

  // The universal contract — for ARBITRARY markdown-ish byte pairs, not
  // just the structured generator's class: diffToHunks self-verifies and
  // degrades to a whole-document hunk when granular hunks can't reproduce
  // the proposal, so these two lines hold for every input.
  it("holds the diff contract on chaotic inputs: empty ⟺ identical, apply-all === proposed", () => {
    const chaosDocArb = fc
      .array(
        fc.record({
          body: fc.oneof(
            fc.constantFrom(
              "plain paragraph text",
              "## a heading",
              "- list item one",
              "- list item two",
              "> a quote block",
              "```txt\ncode body\n```",
              "| a | b |\n| - | - |\n| 1 | 2 |",
              "---",
              "[ref]: https://example.com",
              "**bold** and *italic* and [link][ref]",
            ),
            fc.string({ minLength: 1, maxLength: 24 }),
          ),
          sep: fc.constantFrom("\n", "\n\n", "\n\n\n", "\r\n\r\n"),
        }),
        { minLength: 0, maxLength: 8 },
      )
      .map((parts) => {
        let doc = "";
        parts.forEach((p, i) => {
          doc += (i > 0 ? p.sep : "") + p.body;
        });
        return doc;
      });
    // The edge decoration is independent of the doc — tuple, not chain
    // (shrinks better).
    const chaosWithEdgeArb = fc
      .tuple(
        chaosDocArb,
        fc.constantFrom("", "\n", "\n\n", "---\nkey: value\n---\n\n"),
      )
      .map(([doc, edge]) => (edge.startsWith("---") ? edge + doc : doc + edge));

    fc.assert(
      fc.property(chaosWithEdgeArb, chaosWithEdgeArb, (base, proposed) => {
        const hunks = diffToHunks(base, proposed);
        if (base === proposed) {
          expect(hunks).toEqual([]);
        } else {
          expect(hunks.length).toBeGreaterThan(0);
          expect(applyHunks(base, hunks)).toBe(proposed);
        }
      }),
      PROPERTY_RUNS,
    );
  });
});
