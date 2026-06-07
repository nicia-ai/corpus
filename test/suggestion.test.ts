import { describe, expect, it } from "vitest";

import { applyHunks, diffToHunks } from "../src/store/domain/suggestion";

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
});
