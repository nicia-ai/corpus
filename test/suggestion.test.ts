import { describe, expect, it } from "vitest";

import {
  applyHunks,
  computeProposalOutcome,
  diffToHunks,
} from "../src/store/domain/suggestion";

const norm = (s: string): string =>
  s
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");

describe("diffToHunks / applyHunks", () => {
  it("produces no hunks when nothing changed", () => {
    const doc = "alpha lead\n\nbeta middle\n\ngamma tail";
    expect(diffToHunks(doc, doc)).toEqual([]);
    expect(applyHunks(doc, [])).toBe(norm(doc));
  });

  it("round-trips: applying ALL hunks reproduces the proposal", () => {
    const cases: readonly (readonly [string, string])[] = [
      // replace one block
      ["the quick brown fox\n\ntwo", "the quick brown cat\n\ntwo"],
      // insert a block
      [
        "alpha line\n\ngamma line",
        "alpha line\n\nbeta inserted line\n\ngamma line",
      ],
      // delete a block
      ["alpha\n\nbeta\n\ngamma", "alpha\n\ngamma"],
      // mixed: edit a block + append one
      [
        "intro para\n\nold middle text\n\ntail para",
        "intro para\n\nnew middle text here\n\ntail para\n\nappended para",
      ],
    ];
    for (const [base, proposed] of cases) {
      expect(applyHunks(base, diffToHunks(base, proposed))).toBe(
        norm(proposed),
      );
    }
  });

  it("applies only the selected hunks (per-hunk accept)", () => {
    const base = "the quick brown fox\n\ntwo middle\n\nthree end";
    // block0 edited (stays similar → a replace hunk); block2 deleted.
    const proposed = "the quick brown cat\n\ntwo middle";
    const hunks = diffToHunks(base, proposed);
    const deletes = hunks.filter((h) => h.op === "delete");
    expect(deletes.length).toBeGreaterThan(0);
    // Apply ONLY the deletion: block2 gone, block0 untouched.
    expect(applyHunks(base, deletes)).toBe("the quick brown fox\n\ntwo middle");
  });

  it("each replace/delete hunk carries the base source range it targets", () => {
    const base = "alpha\n\nbeta\n\ngamma";
    const hunks = diffToHunks(base, "alpha\n\ngamma"); // delete beta
    const del = hunks.find((h) => h.op === "delete");
    expect(del).toBeDefined();
    if (del) expect(base.slice(del.baseStart, del.baseEnd)).toBe("beta");
  });

  it("preserves blank lines inside a fenced code block when applying a hunk", () => {
    // The code block has TWO consecutive blank lines that are significant; a
    // naive global /\n{3,}/→\n\n would collapse them and corrupt the sample.
    const base =
      "intro paragraph\n\n```js\nconst a = 1;\n\n\nconst b = 2;\n```\n\nold tail";
    const proposed =
      "intro paragraph\n\n```js\nconst a = 1;\n\n\nconst b = 2;\n```\n\nnew tail";
    const out = applyHunks(base, diffToHunks(base, proposed));
    expect(out).toContain("const a = 1;\n\n\nconst b = 2;");
    expect(out).toContain("new tail");
  });
});

describe("computeProposalOutcome", () => {
  it("derives partial application only from an applied mixed decision set", () => {
    expect(
      computeProposalOutcome("applied", [
        { decision: "accepted" },
        { decision: "rejected" },
      ]),
    ).toBe("partially_applied");
    expect(computeProposalOutcome("applied", [{ decision: "accepted" }])).toBe(
      "applied",
    );
    expect(
      computeProposalOutcome("open", [
        { decision: "accepted" },
        { decision: "rejected" },
      ]),
    ).toBe("open");
  });
});
