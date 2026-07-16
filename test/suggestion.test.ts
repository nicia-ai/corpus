import { describe, expect, it } from "vitest";

import {
  applyHunks,
  computeProposalOutcome,
  diffToHunks,
  type Hunk,
} from "../src/store/domain/suggestion";

describe("diffToHunks / applyHunks", () => {
  it("produces no hunks when nothing changed", () => {
    const doc = "alpha lead\n\nbeta middle\n\ngamma tail";
    expect(diffToHunks(doc, doc)).toEqual([]);
    expect(applyHunks(doc, [])).toBe(doc);
  });

  it("round-trips: applying ALL hunks reproduces the proposal byte-for-byte", () => {
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
      // trailing newline on both sides survives
      ["alpha one\n\nbeta two\n", "alpha one\n\nbeta two edited\n"],
    ];
    for (const [base, proposed] of cases) {
      expect(applyHunks(base, diffToHunks(base, proposed))).toBe(proposed);
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
    expect(out).toBe(proposed);
  });

  // Regression: the 2026-07-16 dogfood found per-hunk apply loosening a
  // proposed tight list (each accepted bullet came back blank-line
  // separated) and stripping the document's trailing newline.
  it("keeps a proposed tight list tight under partial acceptance", () => {
    const base = "# Log\n\nExisting entry text.\n";
    const proposed =
      "# Log\n\nExisting entry text.\n\n---\n\n## New ingest\n\n" +
      "- **Source:** dialogue.md\n- **Pages created:** one-pager\n" +
      "- **Pages updated:** none\n- **Rationale:** meta-commentary\n";
    const hunks = diffToHunks(base, proposed);
    // separator, heading, and one hunk per bullet
    expect(hunks.map((h) => h.op)).toEqual([
      "insert",
      "insert",
      "insert",
      "insert",
      "insert",
      "insert",
    ]);
    // Reviewer rejects the last bullet, accepts the rest.
    const accepted = hunks.slice(0, -1);
    expect(applyHunks(base, accepted)).toBe(
      "# Log\n\nExisting entry text.\n\n---\n\n## New ingest\n\n" +
        "- **Source:** dialogue.md\n- **Pages created:** one-pager\n" +
        "- **Pages updated:** none\n",
    );
  });

  it("inserting into an existing tight list keeps the tight join", () => {
    const base = "- alpha item\n- gamma item";
    const proposed = "- alpha item\n- beta item\n- gamma item";
    const hunks = diffToHunks(base, proposed);
    expect(hunks.map((h) => h.op)).toEqual(["insert"]);
    expect(applyHunks(base, hunks)).toBe(proposed);
  });

  it("deleting from a tight list keeps the surviving items tight", () => {
    const base = "- alpha item\n- beta item\n- gamma item";
    const proposed = "- alpha item\n- gamma item";
    const hunks = diffToHunks(base, proposed);
    expect(hunks.map((h) => h.op)).toEqual(["delete"]);
    expect(applyHunks(base, hunks)).toBe(proposed);
  });

  // Regression: block matching identifies blocks by PLAIN text, so a
  // formatting-only edit used to match "unchanged" and silently vanish
  // from the proposal.
  it("a formatting-only edit still produces a reviewable hunk", () => {
    const base = "some **bold** words\n\nsecond paragraph";
    const proposed = "some *bold* words\n\nsecond paragraph";
    const hunks = diffToHunks(base, proposed);
    expect(hunks.map((h) => h.op)).toEqual(["replace"]);
    expect(applyHunks(base, hunks)).toBe(proposed);
  });

  it("a frontmatter-only change is a reviewable hunk and round-trips", () => {
    const base = "---\ntags: [a]\n---\n\n# Title\n\nbody text";
    const proposed = "---\ntags: [a, b]\n---\n\n# Title\n\nbody text";
    const hunks = diffToHunks(base, proposed);
    expect(hunks).toHaveLength(1);
    expect(applyHunks(base, hunks)).toBe(proposed);
  });

  it("a spacing-only change falls back to one whole-document hunk", () => {
    // Both blocks byte-identical; only the separator between them changed.
    // The block lens can't see it, so the diff degrades to a single
    // whole-document replace: still reviewable, still appliable.
    const base = "- alpha item\n\n- beta item";
    const proposed = "- alpha item\n- beta item";
    const hunks = diffToHunks(base, proposed);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.op).toBe("replace");
    expect(applyHunks(base, hunks)).toBe(proposed);
  });

  it("diffToHunks is empty exactly when the documents are byte-identical", () => {
    expect(diffToHunks("a b c", "a b c")).toEqual([]);
    expect(diffToHunks("a b c", "a b c ").length).toBeGreaterThan(0);
    expect(diffToHunks("a b c\n", "a b c").length).toBeGreaterThan(0);
  });

  // The self-verification contract: when the block lens cannot represent a
  // change faithfully, the diff degrades to ONE whole-document hunk rather
  // than offering granular hunks that would silently drop part of the
  // proposal under apply.
  it("a move alongside an edit degrades to a whole-document hunk", () => {
    // Content-first matching carries the moved block as "unchanged" (no
    // hunk represents the move), so granular hunks would keep base order.
    const base = "alpha one\n\nbeta two\n\ngamma three";
    const proposed = "beta two\n\nalpha one\n\ngamma three EDITED";
    const hunks = diffToHunks(base, proposed);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.baseEnd).toBe(base.length);
    expect(applyHunks(base, hunks)).toBe(proposed);
  });

  it("a link-reference-definition edit degrades to a whole-document hunk", () => {
    // Definition nodes are invisible to the block lens; a granular diff
    // would silently keep the base definition.
    const base = "see [docs]\n\n[docs]: https://old.example\n\ntail para";
    const proposed =
      "see [docs]\n\n[docs]: https://new.example\n\ntail para EDITED";
    const hunks = diffToHunks(base, proposed);
    expect(hunks).toHaveLength(1);
    expect(applyHunks(base, hunks)).toBe(proposed);
  });

  it("round-trips CRLF documents", () => {
    const base = "alpha one\r\n\r\nbeta two";
    const proposed = "alpha one\r\n\r\nbeta two EDITED";
    expect(applyHunks(base, diffToHunks(base, proposed))).toBe(proposed);
  });

  // Rows created before the separator columns existed apply with the old
  // synthesized joins (blank-line insert separators, global blank-run
  // collapse + edge trims after a delete).
  it("legacy hunks (empty separators) keep the old apply behavior", () => {
    const legacy = (h: Hunk): Hunk => ({ ...h, leadSep: "", trailSep: "" });
    const base = "alpha one\n\nbeta two\n\ngamma three";

    const insert = diffToHunks(
      base,
      "alpha one\n\ninserted here\n\nbeta two\n\ngamma three",
    ).map(legacy);
    expect(applyHunks(base, insert)).toBe(
      "alpha one\n\ninserted here\n\nbeta two\n\ngamma three",
    );

    const del = diffToHunks(base, "alpha one\n\ngamma three").map(legacy);
    expect(applyHunks(base, del)).toBe("alpha one\n\ngamma three");
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
