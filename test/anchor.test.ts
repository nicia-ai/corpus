import {
  asBlockId,
  type Block,
  type BlockId,
  matchBlocks,
  type MatchResult,
  type NextBlock,
} from "@nicia-ai/prose-diff";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  type Anchor,
  rebaseAnchors,
  resolveAnchor,
  type RebaseResult,
} from "../src/store/domain/anchor";

function block(id: string, text: string): Block {
  return { id: asBlockId(id), kind: "paragraph", text };
}

function minter(): () => BlockId {
  let n = 0;
  return () => asBlockId(`mint-${(n += 1).toString()}`);
}

function rebaseOneAnchor(anchor: Anchor, match: MatchResult): RebaseResult {
  const out = rebaseAnchors([anchor], match);
  const first = out[0];
  if (first === undefined) throw new Error("expected one result");
  return first;
}

// Text the rebased anchor now slices to — the safety check.
function slice(result: RebaseResult, match: MatchResult): string | undefined {
  if (result.status !== "anchored") return undefined;
  const target = match.blocks.find((b) => b.id === result.anchor.blockId);
  return target?.text.slice(result.anchor.start, result.anchor.end);
}

// --- resolveAnchor ----------------------------------------------------

describe("resolveAnchor", () => {
  it("captures exact text plus surrounding context", () => {
    const a = resolveAnchor(
      block("A", "the retention policy reaps versions"),
      4,
      20,
    );
    expect(a.quote.exact).toBe("retention policy");
    expect(a.quote.prefix).toBe("the ");
    expect(a.quote.suffix).toBe(" reaps versions");
  });
});

// --- rebase paths -----------------------------------------------------

describe("rebaseAnchors", () => {
  function anchorOn(b: Block, exact: string): Anchor {
    const start = b.text.indexOf(exact);
    return resolveAnchor(b, start, start + exact.length);
  }

  it("an unchanged block keeps the anchor put", () => {
    const A = block("A", "alpha beta gamma");
    const anchor = anchorOn(A, "beta");
    const match = matchBlocks({
      prev: [A],
      next: [{ kind: "paragraph", text: "alpha beta gamma" }],
      mintId: minter(),
    });
    const r = rebaseOneAnchor(anchor, match);
    expect(r.status).toBe("anchored");
    if (r.status === "anchored") {
      expect(r.anchor.blockId).toBe(asBlockId("A"));
      expect(r.anchor.start).toBe(6);
    }
    expect(slice(r, match)).toBe("beta");
  });

  it("follows a moved block to its new position", () => {
    const A = block("A", "alpha unique-phrase here");
    const B = block("B", "second block");
    const anchor = anchorOn(A, "unique-phrase");
    const match = matchBlocks({
      prev: [A, B],
      next: [
        { kind: "paragraph", text: "second block" },
        { kind: "paragraph", text: "alpha unique-phrase here" },
      ],
      mintId: minter(),
    });
    const r = rebaseOneAnchor(anchor, match);
    expect(r.status).toBe("anchored");
    if (r.status === "anchored") expect(r.anchor.blockId).toBe(asBlockId("A"));
    expect(slice(r, match)).toBe("unique-phrase");
  });

  it("relocates within a modified block when the quote survives", () => {
    const A = block("A", "the retention policy reaps versions");
    const anchor = anchorOn(A, "retention policy");
    const match = matchBlocks({
      prev: [A],
      next: [
        {
          kind: "paragraph",
          text: "NOTE: the retention policy reaps versions",
        },
      ],
      mintId: minter(),
    });
    const r = rebaseOneAnchor(anchor, match);
    expect(r.status).toBe("anchored");
    if (r.status === "anchored") {
      expect(r.anchor.blockId).toBe(asBlockId("A")); // carried as modified
      expect(r.anchor.start).toBe(10); // shifted by "NOTE: " (6 chars)
    }
    expect(slice(r, match)).toBe("retention policy");
  });

  it("refreshes quote context after a successful rebase", () => {
    const A = block("A", "old prefix selected phrase old suffix");
    const anchor = anchorOn(A, "selected phrase");
    const match = matchBlocks({
      prev: [A],
      next: [{ kind: "paragraph", text: "new prefix selected phrase fresh" }],
      mintId: minter(),
    });
    const r = rebaseOneAnchor(anchor, match);
    expect(r.status).toBe("anchored");
    if (r.status === "anchored") {
      expect(r.anchor.quote).toEqual({
        prefix: "new prefix ",
        exact: "selected phrase",
        suffix: " fresh",
      });
    }
  });

  it("orphans when the quoted text is edited away (even if the block carries)", () => {
    const A = block("A", "alpha beta gamma delta epsilon zeta");
    const anchor = anchorOn(A, "gamma");
    const match = matchBlocks({
      prev: [A],
      // 'gamma' replaced; the block is still similar enough to carry.
      next: [
        { kind: "paragraph", text: "alpha beta REPLACED delta epsilon zeta" },
      ],
      mintId: minter(),
    });
    const r = rebaseOneAnchor(anchor, match);
    expect(r.status).toBe("orphaned");
    if (r.status === "orphaned") expect(r.quote.exact).toBe("gamma");
  });

  it("recovers across blocks when content is cut and pasted elsewhere", () => {
    const A = block("A", "unique alpha phrase here");
    const B = block("B", "second block");
    const anchor = anchorOn(A, "alpha phrase");
    const match = matchBlocks({
      prev: [A, B],
      next: [
        { kind: "paragraph", text: "second block" },
        { kind: "paragraph", text: "now contains alpha phrase inside" },
      ],
      mintId: minter(),
    });
    const r = rebaseOneAnchor(anchor, match);
    expect(r.status).toBe("anchored");
    // re-anchored onto whichever new block now holds the text
    expect(slice(r, match)).toBe("alpha phrase");
  });

  it("orphans when the quoted text is gone entirely", () => {
    const A = block("A", "alpha beta gamma");
    const anchor = anchorOn(A, "beta");
    const match = matchBlocks({
      prev: [A],
      next: [{ kind: "paragraph", text: "totally different content here" }],
      mintId: minter(),
    });
    const r = rebaseOneAnchor(anchor, match);
    expect(r.status).toBe("orphaned");
  });

  it("uses surrounding context to pick the right duplicate occurrence", () => {
    const A = block("A", "foo bar foo baz");
    // anchor the SECOND 'foo' (offset 8)
    const anchor = resolveAnchor(A, 8, 11);
    const match = matchBlocks({
      prev: [A],
      next: [{ kind: "paragraph", text: "foo bar foo baz" }],
      mintId: minter(),
    });
    const r = rebaseOneAnchor(anchor, match);
    expect(r.status).toBe("anchored");
    if (r.status === "anchored") expect(r.anchor.start).toBe(8);
  });

  it("cross-block recovery picks the block whose context matches, not the first", () => {
    // The carrying block is rewritten so the quote must recover elsewhere;
    // the same exact phrase exists in TWO surviving blocks. Context decides.
    const A = block("A", "carrier mentioning approved once");
    const B = block("B", "left side then approved and a bit more");
    const C = block("C", "the plan was approved yesterday afternoon");
    const anchor = resolveAnchor(C, 13, 21); // "approved" with C's context
    const match = matchBlocks({
      prev: [A, B, C],
      next: [
        { kind: "paragraph", text: "carrier totally rewritten now gone" },
        { kind: "paragraph", text: "left side then approved and a bit more" },
        {
          kind: "paragraph",
          text: "the plan was approved yesterday afternoon",
        },
      ],
      mintId: minter(),
    });
    const r = rebaseOneAnchor(anchor, match);
    expect(r.status).toBe("anchored");
    // Must land on C (its surrounding context), not B (the earlier match).
    if (r.status === "anchored") {
      expect(r.anchor.blockId).toBe(asBlockId("C"));
      expect(slice(r, match)).toBe("approved");
    }
  });

  it("a caret (empty selection) orphans when its block is gone rather than floating", () => {
    const A = block("A", "delete this whole paragraph");
    const caret = resolveAnchor(A, 27, 27); // zero-width: exact === ""
    const match = matchBlocks({
      prev: [A],
      next: [{ kind: "paragraph", text: "completely different replacement" }],
      mintId: minter(),
    });
    const r = rebaseOneAnchor(caret, match);
    expect(r.status).toBe("orphaned");
  });
});

// --- safety property: an anchored result NEVER lands on wrong text -----

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

describe("rebaseAnchors safety (property)", () => {
  it("anchored ⇒ slices to the exact quote; survivor ⇒ anchored, deleted ⇒ orphaned", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.array(structuralOp, { minLength: 0, maxLength: 12 }),
        fc.nat(100),
        fc.nat(100),
        (baseSize, ops, blockPick, spanPick) => {
          // Each block holds four globally-unique tokens, so any token span
          // identifies exactly one block — structural edits never change a
          // surviving block's text.
          let truth = 0;
          const base: number[] = [];
          for (let k = 0; k < baseSize; k += 1) base.push((truth += 1));
          const textOf = (t: number): string =>
            ["a", "b", "c", "d"].map((s) => `w${t.toString()}${s}`).join(" ");

          const prev: Block[] = base.map((t) =>
            block(`b${t.toString()}`, textOf(t)),
          );

          // anchor a 2-token span inside one chosen block
          const target = base[blockPick % base.length];
          if (target === undefined) return;
          const targetText = textOf(target);
          const tokenStarts = [0, targetText.indexOf(" ") + 1];
          const s = tokenStarts[spanPick % tokenStarts.length] ?? 0;
          const exact = targetText.slice(s, targetText.indexOf(" ", s + 1));
          const anchor = resolveAnchor(
            { id: asBlockId(`b${target.toString()}`), text: targetText },
            s,
            s + exact.length,
          );

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
          const next: NextBlock[] = work.map((t) => ({
            kind: "paragraph",
            text: textOf(t),
          }));
          const match = matchBlocks({ prev, next, mintId: minter() });
          const r = rebaseOneAnchor(anchor, match);

          // Safety: an anchored result always slices to the exact quote.
          if (r.status === "anchored") {
            const target2 = match.blocks.find((b) => b.id === r.anchor.blockId);
            expect(target2?.text.slice(r.anchor.start, r.anchor.end)).toBe(
              exact,
            );
          }
          // Survivor ⇒ anchored (same block, unique content); deleted ⇒
          // orphaned (the unique tokens exist nowhere else).
          if (work.includes(target)) {
            expect(r.status).toBe("anchored");
            if (r.status === "anchored") {
              expect(r.anchor.blockId).toBe(asBlockId(`b${target.toString()}`));
            }
          } else {
            expect(r.status).toBe("orphaned");
          }

          // determinism
          const r2 = rebaseOneAnchor(anchor, match);
          expect(r2).toEqual(r);
        },
      ),
      { numRuns: 400, seed: 20260607 },
    );
  });
});
