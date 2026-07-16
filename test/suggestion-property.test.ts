import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  applyHunks,
  diffToHunks,
  type Hunk,
} from "../src/store/domain/suggestion";

const PROPERTY_RUNS = { numRuns: 300, seed: 20260607 } as const;

// — Reference model ——————————————————————————————————————————————————
//
// THE executable spec for what a mixed decision set means (stage-1 of the
// rejected-revert reformulation): the output is the PROPOSED document with
// every rejected hunk reverted —
//   rejected replace — the base bytes come back in the proposed block's
//     place; the separators around it stay as the proposer wrote them.
//   rejected insert  — the inserted bytes vanish along with exactly ONE
//     junction separator: the leading one when the walk still has one to
//     consume before the block, otherwise the trailing one (the document
//     head, or stacked directly on another reverted hunk that already
//     consumed the lead).
//   rejected delete  — the base block bytes re-enter at the junction,
//     attached to the survivor before them by their base-side leading
//     separator; at the document head (no survivor) they carry their base
//     trailing separator instead, and a run of head deletes at the same
//     junction chains that way.
// Spacing under a mixed decision set is PROPOSED-authoritative: bytes
// between surviving blocks are whatever the proposer wrote, never
// re-synthesized from the base. `applyHunks` must match this model exactly.
function referenceApply(
  base: string,
  proposed: string,
  rejected: readonly Hunk[],
): string {
  const tailWs = (s: string): string => /\s*$/.exec(s)?.[0] ?? "";
  const headWs = (s: string): string => /^\s*/.exec(s)?.[0] ?? "";
  const ordered = [...rejected].sort(
    (a, b) =>
      a.propStart - b.propStart ||
      a.propEnd - b.propEnd ||
      a.ordinal - b.ordinal,
  );
  let out = "";
  let cursor = 0;
  let headRunAt = -1;
  for (const h of ordered) {
    const gap = proposed.slice(cursor, h.propStart);
    cursor = h.propEnd;
    const contentBefore = /\S/.test(out + gap);
    if (h.op === "delete") {
      const bytes = base.slice(h.baseStart, h.baseEnd);
      if (contentBefore && headRunAt !== h.propStart) {
        out += gap + tailWs(base.slice(0, h.baseStart)) + bytes;
      } else {
        out += gap + bytes + headWs(base.slice(h.baseEnd));
        headRunAt = h.propStart;
      }
      continue;
    }
    headRunAt = -1;
    if (h.op === "insert") {
      const lead = tailWs(gap);
      if (lead === "") {
        out += gap;
        cursor += headWs(proposed.slice(cursor)).length;
      } else {
        out += gap.slice(0, gap.length - lead.length);
      }
      continue;
    }
    out += gap + base.slice(h.baseStart, h.baseEnd); // rejected replace
  }
  return out + proposed.slice(cursor);
}

// — Generators ———————————————————————————————————————————————————————

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

// Arbitrary markdown-ish byte pairs — NOT restricted to the structured
// generator's class — for the universal-contract and chaos-differential
// properties.
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

const decisionMaskArb = fc.array(fc.boolean(), { maxLength: 24 });

// mask[i % mask.length] decides hunk i; an empty mask accepts nothing.
function splitByMask(
  hunks: readonly Hunk[],
  mask: readonly boolean[],
): Readonly<{ accepted: readonly Hunk[]; rejected: readonly Hunk[] }> {
  const acceptedAt = (i: number): boolean =>
    mask.length > 0 && (mask[i % mask.length] ?? false);
  return {
    accepted: hunks.filter((_, i) => acceptedAt(i)),
    rejected: hunks.filter((_, i) => !acceptedAt(i)),
  };
}

// — Properties ———————————————————————————————————————————————————————

describe("suggestion hunks (property)", () => {
  it("accept-all reproduces the proposed markdown byte-for-byte", () => {
    fc.assert(
      fc.property(scenarioArb, ({ base, proposed }) => {
        // Zero reverts ⇒ the proposal verbatim, by construction.
        expect(applyHunks({ base, proposed, rejected: [] })).toBe(proposed);
      }),
      PROPERTY_RUNS,
    );
  });

  it("reject-all reconstructs the base byte-for-byte", () => {
    fc.assert(
      fc.property(scenarioArb, ({ base, proposed }) => {
        const hunks = diffToHunks(base, proposed);
        expect(applyHunks({ base, proposed, rejected: hunks })).toBe(base);
      }),
      PROPERTY_RUNS,
    );
  });

  it("any decision mix is well-formed, with content fidelity per hunk", () => {
    fc.assert(
      fc.property(scenarioArb, decisionMaskArb, ({ base, proposed }, mask) => {
        const hunks = diffToHunks(base, proposed);
        const { accepted, rejected } = splitByMask(hunks, mask);

        const applied = applyHunks({ base, proposed, rejected });
        // Content fidelity under ANY decision mix: every accepted
        // insert/replace body lands verbatim; an accepted delete removes
        // its block; a rejected delete keeps it (block texts are unique by
        // construction, so containment is a faithful check).
        const acceptedSet = new Set(accepted);
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
      }),
      PROPERTY_RUNS,
    );
  });

  // The differential property: the implementation equals the reference
  // model for every decision mask — over the structured generator...
  it("matches the reference model under any decision mask (structured)", () => {
    fc.assert(
      fc.property(scenarioArb, decisionMaskArb, ({ base, proposed }, mask) => {
        const hunks = diffToHunks(base, proposed);
        const { rejected } = splitByMask(hunks, mask);
        expect(applyHunks({ base, proposed, rejected })).toBe(
          referenceApply(base, proposed, rejected),
        );
      }),
      PROPERTY_RUNS,
    );
  });

  // ...and over arbitrary byte pairs (where degradation to the
  // whole-document hunk must ALSO match the model).
  it("matches the reference model under any decision mask (chaos)", () => {
    fc.assert(
      fc.property(
        chaosWithEdgeArb,
        chaosWithEdgeArb,
        decisionMaskArb,
        (base, proposed, mask) => {
          const hunks = diffToHunks(base, proposed);
          const { rejected } = splitByMask(hunks, mask);
          expect(applyHunks({ base, proposed, rejected })).toBe(
            referenceApply(base, proposed, rejected),
          );
        },
      ),
      PROPERTY_RUNS,
    );
  });

  it("hunks carry faithful proposed-side ranges", () => {
    fc.assert(
      fc.property(scenarioArb, ({ base, proposed }) => {
        for (const h of diffToHunks(base, proposed)) {
          // The stored text is exactly the proposed slice (ranges into the
          // two immutable blobs are the representation; the copy is a
          // hydration convenience), and a delete's range is zero-width.
          expect(proposed.slice(h.propStart, h.propEnd)).toBe(h.proposedText);
          if (h.op === "delete") expect(h.propStart).toBe(h.propEnd);
        }
      }),
      PROPERTY_RUNS,
    );
  });

  it("application is independent of hunk input order", () => {
    fc.assert(
      fc.property(scenarioArb, ({ base, proposed }) => {
        const hunks = diffToHunks(base, proposed);
        const reversed = [...hunks].reverse();

        expect(applyHunks({ base, proposed, rejected: reversed })).toBe(
          applyHunks({ base, proposed, rejected: hunks }),
        );
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
  // just the structured generator's class: diffToHunks self-verifies (full
  // rejection must reconstruct the base) and degrades to a whole-document
  // hunk when granular hunks can't, so these lines hold for every input.
  it("holds the diff contract on chaotic inputs: empty ⟺ identical, reject-all === base, accept-all === proposed", () => {
    fc.assert(
      fc.property(chaosWithEdgeArb, chaosWithEdgeArb, (base, proposed) => {
        const hunks = diffToHunks(base, proposed);
        if (base === proposed) {
          expect(hunks).toEqual([]);
        } else {
          expect(hunks.length).toBeGreaterThan(0);
          expect(applyHunks({ base, proposed, rejected: hunks })).toBe(base);
          expect(applyHunks({ base, proposed, rejected: [] })).toBe(proposed);
        }
      }),
      PROPERTY_RUNS,
    );
  });
});
