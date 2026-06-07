import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { asBlockId, type BlockId } from "../src/ids";
import {
  type Block,
  type BlockKind,
  computeIdf,
  matchBlocks,
  type NextBlock,
  tokenSimilarity,
} from "../src/store/domain/block-match";

// --- builders ---------------------------------------------------------

function prev(id: string, text: string, kind: BlockKind = "paragraph"): Block {
  return { id: asBlockId(id), kind, text };
}

function next(text: string, kind: BlockKind = "paragraph"): NextBlock {
  return { kind, text };
}

// Deterministic id minter; minted ids are distinguishable from carried
// ones by the `mint-` prefix so tests can assert "this block is new".
function minter(): () => BlockId {
  let n = 0;
  return () => asBlockId(`mint-${(n += 1).toString()}`);
}

function match(p: readonly Block[], n: readonly NextBlock[]) {
  return matchBlocks({ prev: p, next: n, mintId: minter() });
}

const ids = (r: ReturnType<typeof match>): readonly string[] =>
  r.blocks.map((b) => b.id);
const statuses = (r: ReturnType<typeof match>): readonly string[] =>
  r.blocks.map((b) => b.origin.status);

// --- named adversarial cases -----------------------------------------

describe("matchBlocks (content-first exact tier)", () => {
  it("carries ids for an untouched document", () => {
    const r = match(
      [prev("A", "alpha"), prev("B", "beta")],
      [next("alpha"), next("beta")],
    );
    expect(ids(r)).toEqual(["A", "B"]);
    expect(statuses(r)).toEqual(["unchanged", "unchanged"]);
    expect(r.deleted).toEqual([]);
  });

  it("FOLLOWS A MOVED BLOCK — the headline property", () => {
    // C is dragged to the top; everything keeps its id despite new positions.
    const r = match(
      [prev("A", "alpha"), prev("B", "beta"), prev("C", "gamma")],
      [next("gamma"), next("alpha"), next("beta")],
    );
    expect(ids(r)).toEqual(["C", "A", "B"]);
    expect(statuses(r)).toEqual(["unchanged", "unchanged", "unchanged"]);
    expect(r.deleted).toEqual([]);
  });

  it("reorders whole sections without losing identity", () => {
    const r = match(
      [
        prev("H1", "intro", "heading"),
        prev("P1", "body one"),
        prev("H2", "next", "heading"),
        prev("P2", "body two"),
      ],
      [
        next("next", "heading"),
        next("body two"),
        next("intro", "heading"),
        next("body one"),
      ],
    );
    expect(ids(r)).toEqual(["H2", "P2", "H1", "P1"]);
    expect(r.deleted).toEqual([]);
  });

  it("insertion mints a fresh id and leaves neighbors untouched", () => {
    const r = match(
      [prev("A", "alpha"), prev("B", "beta")],
      [next("alpha"), next("brand new"), next("beta")],
    );
    expect(ids(r)).toEqual(["A", "mint-1", "B"]);
    expect(statuses(r)).toEqual(["unchanged", "inserted", "unchanged"]);
    expect(r.deleted).toEqual([]);
  });

  it("deletion reports the removed id, others unchanged", () => {
    const r = match(
      [prev("A", "alpha"), prev("B", "beta"), prev("C", "gamma")],
      [next("alpha"), next("gamma")],
    );
    expect(ids(r)).toEqual(["A", "C"]);
    expect(r.deleted).toEqual([asBlockId("B")]);
  });

  it("identical duplicates pair by order; the extra copy is a fresh block", () => {
    const r = match(
      [prev("A", "same"), prev("B", "same")],
      [next("same"), next("same"), next("same")],
    );
    expect(ids(r)).toEqual(["A", "B", "mint-1"]);
    expect(statuses(r)).toEqual(["unchanged", "unchanged", "inserted"]);
    expect(r.deleted).toEqual([]);
  });

  it("kind is part of identity — a paragraph promoted to a heading is not a carry", () => {
    const r = match([prev("A", "title")], [next("title", "heading")]);
    expect(statuses(r)).toEqual(["inserted"]);
    expect(r.deleted).toEqual([asBlockId("A")]);
  });
});

describe("matchBlocks (fuzzy 'modified' tier)", () => {
  it("a light edit carries the id as modified", () => {
    const r = match(
      [prev("A", "core idea one two three")],
      [next("core idea one two CHANGED")],
    );
    expect(ids(r)).toEqual(["A"]);
    const origin = r.blocks[0]?.origin;
    expect(origin?.status).toBe("modified");
    if (origin?.status === "modified") {
      expect(origin.similarity).toBeGreaterThanOrEqual(0.5);
    }
  });

  it("a full rewrite is delete + insert, NOT a false carry", () => {
    const r = match(
      [prev("A", "alpha beta gamma delta")],
      [next("zeta eta theta iota")],
    );
    expect(statuses(r)).toEqual(["inserted"]);
    expect(r.deleted).toEqual([asBlockId("A")]);
  });

  it("low overlap stays below threshold and does not conflate distinct blocks", () => {
    // Share exactly one of nine tokens => unweighted Jaccard 1/9.
    expect(
      tokenSimilarity("one two three four five", "one six seven eight nine"),
    ).toBeLessThan(0.5);
    const r = match(
      [prev("A", "one two three four five")],
      [next("one six seven eight nine")],
    );
    expect(statuses(r)).toEqual(["inserted"]);
    expect(r.deleted).toEqual([asBlockId("A")]);
  });

  it("matches an edited block even after it moves (position is only a tiebreak)", () => {
    const r = match(
      [
        prev("A", "keep this stable gist here"),
        prev("B", "second untouched block"),
      ],
      [next("second untouched block"), next("keep this stable gist EDITED")],
    );
    expect(ids(r)).toEqual(["B", "A"]);
    expect(statuses(r)).toEqual(["unchanged", "modified"]);
    expect(r.deleted).toEqual([]);
  });
});

describe("matchBlocks (idf-weighted similarity upgrade)", () => {
  it("idf downweights vocabulary common across the document", () => {
    const prevBlocks = [
      prev("A", "shared apple"),
      prev("B", "shared banana"),
      prev("C", "shared cherry"),
    ];
    const idf = computeIdf(prevBlocks, [next("shared damson")]);
    const w = (t: string): number => idf.get(t) ?? 0;
    // 'shared' is in every block; 'apple' in one — so 'apple' weighs more.
    expect(w("shared")).toBeLessThan(w("apple"));
    // Weighting therefore drags the score below plain Jaccard when the only
    // overlap is the cheap, common token.
    expect(tokenSimilarity("shared apple", "shared damson", idf)).toBeLessThan(
      tokenSimilarity("shared apple", "shared damson"),
    );
  });

  it("does NOT conflate distinct blocks that share boilerplate (regression)", () => {
    // The exact failure the parser integration surfaced: two paragraphs
    // sharing 'alpha beta' with different unique tokens. The deleted block
    // must orphan, the new block must be inserted — not a 'modified' carry.
    const prevBlocks = [
      prev("A", "tok3 alpha beta"),
      prev("K", "keep one alpha beta"),
    ];
    const nextBlocks = [
      next("keep one alpha beta"), // K survives (exact)
      next("tok7 alpha beta"), // genuinely new
    ];
    const r = matchBlocks({
      prev: prevBlocks,
      next: nextBlocks,
      mintId: minter(),
    });
    expect(r.deleted).toEqual([asBlockId("A")]);
    const fresh = r.blocks.find((b) => b.text === "tok7 alpha beta");
    expect(fresh?.origin.status).toBe("inserted");
  });

  it("does not conflate distinct sentences that share only function words", () => {
    const prevBlocks = [
      prev("A", "the team should review the document before publishing it"),
      prev("Z", "an unrelated anchor block to populate the corpus"),
    ];
    const nextBlocks = [
      next("an unrelated anchor block to populate the corpus"), // Z survives
      next("the agent will read the collection when responding to a request"),
    ];
    const r = matchBlocks({
      prev: prevBlocks,
      next: nextBlocks,
      mintId: minter(),
    });
    expect(r.deleted).toEqual([asBlockId("A")]);
  });

  it("never carries across disjoint distinctive vocabulary, even amid shared common words", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 5 }),
        (pCount, nCount) => {
          // Realistic prose shape: a couple of shared common words plus
          // several distinctive words per block; prev and next draw their
          // distinctive words from disjoint pools, so none is an edit of
          // another and none must carry.
          const prevBlocks: Block[] = Array.from({ length: pCount }, (_, i) => {
            const k = i.toString();
            return prev(
              `p${k}`,
              `common one common two pa${k} pb${k} pc${k} pd${k}`,
            );
          });
          const nextBlocks: NextBlock[] = Array.from(
            { length: nCount },
            (_, j) => {
              const k = j.toString();
              return next(`common one common two qa${k} qb${k} qc${k} qd${k}`);
            },
          );
          const r = matchBlocks({
            prev: prevBlocks,
            next: nextBlocks,
            mintId: minter(),
          });
          expect(statuses(r).every((s) => s === "inserted")).toBe(true);
          expect(new Set(r.deleted)).toEqual(
            new Set(prevBlocks.map((b) => b.id)),
          );
        },
      ),
      { numRuns: 200, seed: 20260607 },
    );
  });
});

// --- property: the exact tier is airtight under move/insert/delete ----

type StructuralOp = Readonly<
  | { kind: "insert"; pos: number }
  | { kind: "delete"; pos: number }
  | { kind: "move"; from: number; to: number }
>;

const structuralOp: fc.Arbitrary<StructuralOp> = fc.oneof(
  fc.record({ kind: fc.constant("insert"), pos: fc.nat(20) }),
  fc.record({ kind: fc.constant("delete"), pos: fc.nat(20) }),
  fc.record({ kind: fc.constant("move"), from: fc.nat(20), to: fc.nat(20) }),
);

describe("matchBlocks invariants (property)", () => {
  it("survivors keep their id across any moves/inserts/deletes; deletes/inserts are exact", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.array(structuralOp, { minLength: 0, maxLength: 14 }),
        (baseSize, ops) => {
          // Globally-unique content per block => content identity == ground
          // truth, so the exact tier alone must recover every survivor.
          let truth = 0;
          const base: number[] = [];
          for (let k = 0; k < baseSize; k += 1) base.push((truth += 1));

          const work = [...base];
          for (const op of ops) {
            if (op.kind === "insert") {
              work.splice(Math.min(op.pos, work.length), 0, (truth += 1));
            } else if (op.kind === "delete" && work.length > 0) {
              work.splice(op.pos % work.length, 1);
            } else if (op.kind === "move" && work.length > 1) {
              const removed = work.splice(op.from % work.length, 1);
              const m = removed[0];
              if (m !== undefined) work.splice(op.to % (work.length + 1), 0, m);
            }
          }

          const prevBlocks: Block[] = base.map((t) =>
            prev(`b${t.toString()}`, `tok${t.toString()}`),
          );
          const nextBlocks: NextBlock[] = work.map((t) =>
            next(`tok${t.toString()}`),
          );
          const r = matchBlocks({
            prev: prevBlocks,
            next: nextBlocks,
            mintId: minter(),
          });

          // structural validity
          expect(r.blocks.length).toBe(nextBlocks.length);
          expect(new Set(ids(r)).size).toBe(r.blocks.length);

          const baseSet = new Set(base);
          work.forEach((t, j) => {
            const block = r.blocks[j];
            if (baseSet.has(t)) {
              expect(block?.id).toBe(asBlockId(`b${t.toString()}`));
              expect(block?.origin.status).toBe("unchanged");
            } else {
              expect(block?.origin.status).toBe("inserted");
              expect(block?.id.startsWith("mint-")).toBe(true);
            }
          });

          const survived = new Set(work);
          const expectedDeleted = base
            .filter((t) => !survived.has(t))
            .map((t) => asBlockId(`b${t.toString()}`));
          expect(new Set(r.deleted)).toEqual(new Set(expectedDeleted));

          // determinism: a second run is identical (minus minter identity)
          const r2 = matchBlocks({
            prev: prevBlocks,
            next: nextBlocks,
            mintId: minter(),
          });
          expect(statuses(r2)).toEqual(statuses(r));
          expect(r2.deleted).toEqual(r.deleted);
        },
      ),
      { numRuns: 400, seed: 20260607 },
    );
  });

  it("never invents a match across disjoint content (no false carries)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 6 }),
        (pCount, nCount) => {
          const prevBlocks: Block[] = Array.from({ length: pCount }, (_, i) =>
            prev(
              `p${i.toString()}`,
              `alpha${i.toString()} alpha${i.toString()}x alpha${i.toString()}y`,
            ),
          );
          const nextBlocks: NextBlock[] = Array.from(
            { length: nCount },
            (_, j) =>
              next(
                `zeta${j.toString()} zeta${j.toString()}x zeta${j.toString()}y`,
              ),
          );
          const r = matchBlocks({
            prev: prevBlocks,
            next: nextBlocks,
            mintId: minter(),
          });

          expect(statuses(r).every((s) => s === "inserted")).toBe(true);
          expect(new Set(r.deleted)).toEqual(
            new Set(prevBlocks.map((b) => b.id)),
          );
        },
      ),
      { numRuns: 200, seed: 20260607 },
    );
  });
});
