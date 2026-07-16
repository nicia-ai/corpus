import { describe, expect, it } from "vitest";

import {
  applyHunks,
  computeProposalOutcome,
  diffSuggestion,
  diffToHunks,
} from "../src/store/domain/suggestion";

describe("diffToHunks / applyHunks", () => {
  it("produces no hunks when nothing changed", () => {
    const doc = "alpha lead\n\nbeta middle\n\ngamma tail";
    expect(diffToHunks(doc, doc)).toEqual([]);
    expect(applyHunks({ base: doc, proposed: doc, rejected: [] })).toBe(doc);
  });

  it("round-trips both directions: accept-all === proposed, reject-all === base", () => {
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
      const hunks = diffToHunks(base, proposed);
      expect(applyHunks({ base, proposed, rejected: [] })).toBe(proposed);
      expect(applyHunks({ base, proposed, rejected: hunks })).toBe(base);
    }
  });

  it("applies only the selected hunks (per-hunk accept)", () => {
    const base = "the quick brown fox\n\ntwo middle\n\nthree end";
    // block0 edited (stays similar → a replace hunk); block2 deleted.
    const proposed = "the quick brown cat\n\ntwo middle";
    const hunks = diffToHunks(base, proposed);
    expect(hunks.filter((h) => h.op === "delete").length).toBeGreaterThan(0);
    // Accept ONLY the deletion (reject the edit): block2 gone, block0
    // reverted to its base bytes.
    const rejected = hunks.filter((h) => h.op !== "delete");
    expect(applyHunks({ base, proposed, rejected })).toBe(
      "the quick brown fox\n\ntwo middle",
    );
  });

  it("each hunk carries the base range it targets and its proposed mirror", () => {
    const base = "alpha\n\nbeta\n\ngamma";
    const proposed = "alpha\n\ngamma";
    const hunks = diffToHunks(base, proposed); // delete beta
    const del = hunks.find((h) => h.op === "delete");
    expect(del).toBeDefined();
    if (del) {
      expect(base.slice(del.baseStart, del.baseEnd)).toBe("beta");
      // Zero-width junction at the end of the surviving block before it.
      expect(del.propStart).toBe(del.propEnd);
      expect(del.propStart).toBe("alpha".length);
    }
  });

  it("preserves blank lines inside a fenced code block when reverting a hunk", () => {
    // The code block has TWO consecutive blank lines that are significant;
    // reverting the tail edit must reconstruct the base without touching
    // them (no global blank-line collapse may exist on the apply path).
    const base =
      "intro paragraph\n\n```js\nconst a = 1;\n\n\nconst b = 2;\n```\n\nold tail";
    const proposed =
      "intro paragraph\n\n```js\nconst a = 1;\n\n\nconst b = 2;\n```\n\nnew tail";
    const hunks = diffToHunks(base, proposed);
    expect(applyHunks({ base, proposed, rejected: [] })).toBe(proposed);
    expect(applyHunks({ base, proposed, rejected: hunks })).toBe(base);
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
    const rejected = hunks.slice(-1);
    expect(applyHunks({ base, proposed, rejected })).toBe(
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
    expect(applyHunks({ base, proposed, rejected: [] })).toBe(proposed);
    expect(applyHunks({ base, proposed, rejected: hunks })).toBe(base);
  });

  it("deleting from a tight list keeps the surviving items tight", () => {
    const base = "- alpha item\n- beta item\n- gamma item";
    const proposed = "- alpha item\n- gamma item";
    const hunks = diffToHunks(base, proposed);
    expect(hunks.map((h) => h.op)).toEqual(["delete"]);
    expect(applyHunks({ base, proposed, rejected: [] })).toBe(proposed);
    expect(applyHunks({ base, proposed, rejected: hunks })).toBe(base);
  });

  // The reformulation's semantics change, pinned: spacing is
  // proposed-authoritative, so an insert that RE-SPACES its neighborhood (a
  // loose paragraph dropped into a tight list — accepting it must loosen
  // the alpha/gamma join) admits no granular hunk set where accept-all
  // reproduces the proposal AND reject-all reconstructs the base. The old
  // base-authoritative splice papered over this with a synthesized join;
  // the rejected-revert model makes it honest: one whole-document decision.
  it("an insert that re-spaces its neighborhood degrades to a whole-document hunk", () => {
    const base = "- alpha item\n- gamma item";
    const proposed = "- alpha item\n\nbeta paragraph\n\n- gamma item";
    const hunks = diffToHunks(base, proposed);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.op).toBe("replace");
    expect(applyHunks({ base, proposed, rejected: [] })).toBe(proposed);
    expect(applyHunks({ base, proposed, rejected: hunks })).toBe(base);
  });

  // Regression: block matching identifies blocks by PLAIN text, so a
  // formatting-only edit used to match "unchanged" and silently vanish
  // from the proposal.
  it("a formatting-only edit still produces a reviewable hunk", () => {
    const base = "some **bold** words\n\nsecond paragraph";
    const proposed = "some *bold* words\n\nsecond paragraph";
    const hunks = diffToHunks(base, proposed);
    expect(hunks.map((h) => h.op)).toEqual(["replace"]);
    expect(applyHunks({ base, proposed, rejected: [] })).toBe(proposed);
    expect(applyHunks({ base, proposed, rejected: hunks })).toBe(base);
  });

  it("a frontmatter-only change is a reviewable hunk and round-trips", () => {
    const base = "---\ntags: [a]\n---\n\n# Title\n\nbody text";
    const proposed = "---\ntags: [a, b]\n---\n\n# Title\n\nbody text";
    const hunks = diffToHunks(base, proposed);
    expect(hunks).toHaveLength(1);
    expect(applyHunks({ base, proposed, rejected: [] })).toBe(proposed);
    expect(applyHunks({ base, proposed, rejected: hunks })).toBe(base);
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
    expect(applyHunks({ base, proposed, rejected: [] })).toBe(proposed);
    expect(applyHunks({ base, proposed, rejected: hunks })).toBe(base);
  });

  it("diffToHunks is empty exactly when the documents are byte-identical", () => {
    expect(diffToHunks("a b c", "a b c")).toEqual([]);
    expect(diffToHunks("a b c", "a b c ").length).toBeGreaterThan(0);
    expect(diffToHunks("a b c\n", "a b c").length).toBeGreaterThan(0);
  });

  // The diff aligns blocks ORDER-PRESERVING (never move-following — that
  // lens belongs to comment anchors), so a relocation is an explicit
  // delete + insert pair: granular and reviewable instead of degrading to
  // one whole-document decision.
  it("a pure move produces a granular delete + insert pair", () => {
    const base = "alpha one\n\nbeta two\n\ngamma three";
    const proposed = "beta two\n\nalpha one\n\ngamma three";
    const diff = diffSuggestion(base, proposed);
    expect(diff.granularity).toBe("block");
    expect(diff.hunks.map((h) => h.op).sort()).toEqual(["delete", "insert"]);
    const del = diff.hunks.find((h) => h.op === "delete");
    const ins = diff.hunks.find((h) => h.op === "insert");
    expect(del && base.slice(del.baseStart, del.baseEnd)).toBe("alpha one");
    expect(ins?.proposedText).toBe("alpha one");
    expect(applyHunks({ base, proposed, rejected: [] })).toBe(proposed);
    expect(applyHunks({ base, proposed, rejected: diff.hunks })).toBe(base);
  });

  it("a move alongside an edit stays granular (each decidable on its own)", () => {
    const base = "alpha one\n\nbeta two\n\ngamma three";
    const proposed = "beta two\n\nalpha one\n\ngamma three EDITED";
    const diff = diffSuggestion(base, proposed);
    expect(diff.granularity).toBe("block");
    expect(diff.hunks.map((h) => h.op).sort()).toEqual([
      "delete",
      "insert",
      "replace",
    ]);
    // The edit is its own replace hunk, independent of the move pair.
    const rep = diff.hunks.find((h) => h.op === "replace");
    expect(rep?.proposedText).toBe("gamma three EDITED");
    expect(applyHunks({ base, proposed, rejected: [] })).toBe(proposed);
    expect(applyHunks({ base, proposed, rejected: diff.hunks })).toBe(base);
  });

  // Partial acceptance of a move's pair does the predictable per-hunk
  // thing — the pair is two independent decisions, not an atomic move.
  it("accepting only a move's insert duplicates the block; only its delete drops it", () => {
    const base = "alpha one\n\nbeta two\n\ngamma three";
    const proposed = "beta two\n\nalpha one\n\ngamma three";
    const hunks = diffToHunks(base, proposed);
    const deletes = hunks.filter((h) => h.op === "delete");
    const inserts = hunks.filter((h) => h.op === "insert");
    // Accept the insert, reject the delete: the block lands in its new
    // spot AND stays in its old one.
    expect(applyHunks({ base, proposed, rejected: deletes })).toBe(
      "alpha one\n\nbeta two\n\nalpha one\n\ngamma three",
    );
    // Reject the insert, accept the delete: the block is gone entirely.
    expect(applyHunks({ base, proposed, rejected: inserts })).toBe(
      "beta two\n\ngamma three",
    );
  });

  // The self-verification contract: when the block lens cannot represent a
  // change faithfully (full rejection would not reconstruct the base), the
  // diff degrades to ONE whole-document hunk rather than offering granular
  // hunks whose reverts would distort part of the base or the proposal.
  it("a link-reference-definition edit degrades to a whole-document hunk", () => {
    // Definition nodes are invisible to the block lens; a granular diff
    // would silently keep the base definition.
    const base = "see [docs]\n\n[docs]: https://old.example\n\ntail para";
    const proposed =
      "see [docs]\n\n[docs]: https://new.example\n\ntail para EDITED";
    const hunks = diffToHunks(base, proposed);
    expect(hunks).toHaveLength(1);
    expect(applyHunks({ base, proposed, rejected: [] })).toBe(proposed);
    expect(applyHunks({ base, proposed, rejected: hunks })).toBe(base);
  });

  it("round-trips CRLF documents", () => {
    const base = "alpha one\r\n\r\nbeta two";
    const proposed = "alpha one\r\n\r\nbeta two EDITED";
    const hunks = diffToHunks(base, proposed);
    expect(applyHunks({ base, proposed, rejected: [] })).toBe(proposed);
    expect(applyHunks({ base, proposed, rejected: hunks })).toBe(base);
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
