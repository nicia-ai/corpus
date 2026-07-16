import { describe, expect, it } from "vitest";

import { alignBlocks } from "../src/store/domain/block-align";
import type { NextBlock } from "../src/store/domain/block-match";
import { diffSuggestion } from "../src/store/domain/suggestion";

const para = (text: string): NextBlock => ({ kind: "paragraph", text });

// One segment: a signature-unique-in-both anchor followed by a gap of
// `width` blocks whose base and proposed sides share most tokens (so the
// similarity DP would pair every facing pair as a replace when it runs)
// but no exact signature (so the exact-match LCS has nothing to do).
function segmented(
  segments: number,
  width: number,
): Readonly<{ base: readonly NextBlock[]; proposed: readonly NextBlock[] }> {
  const base: NextBlock[] = [];
  const proposed: NextBlock[] = [];
  for (let s = 0; s < segments; s += 1) {
    const anchor = para(`anchor ${String(s)} unique in both documents`);
    base.push(anchor);
    proposed.push(anchor);
    for (let k = 0; k < width; k += 1) {
      const shared = `segment ${String(s)} item ${String(k)} shared body words`;
      base.push(para(`${shared} old`));
      proposed.push(para(`${shared} new`));
    }
  }
  return { base, proposed };
}

describe("alignBlocks cell budget", () => {
  // Regression (re-review, 2026-07-16): the DP ceiling used to apply
  // PER GAP, so many individually-legal gaps multiplied into seconds of
  // work (twenty 400×400 gaps ≈ 3s) on a serialized DO. The budget is
  // one request-scoped pool: gaps that fit pair as replaces; once the
  // pool is spent, later gaps fall out as delete + insert instead of
  // costing more time.
  it("shares one budget across gaps: later gaps stop pairing instead of costing time", () => {
    // 6 gaps × 240×240 = 57.6k cells each. Pool = 160k ⇒ exactly the
    // first two gaps afford their similarity DP; the LCS pass charges
    // nothing (no common signatures inside a gap).
    const { base, proposed } = segmented(6, 240);
    const aligned = alignBlocks({ base, proposed });
    const pairedNonAnchor = aligned.filter(
      (bi, j) => bi !== undefined && proposed[j]?.text.startsWith("segment"),
    ).length;
    expect(pairedNonAnchor).toBe(2 * 240);
  });

  it("stays fast on the many-legal-gaps attack shape", () => {
    // The re-review's measured shape (scaled for CI-stable separation):
    // many gaps, each individually under the old per-gap ceiling. Broken
    // behavior runs every gap's similarity DP (~1.1s+ locally for this
    // shape, 3s for the full-size attack); the shared budget bounds DP
    // work at one pool, leaving only linear parse cost (~250ms locally).
    const { base, proposed } = segmented(12, 300);
    const baseDoc = base.map((b) => b.text).join("\n\n");
    const proposedDoc = proposed.map((b) => b.text).join("\n\n");
    const t0 = performance.now();
    const diff = diffSuggestion(baseDoc, proposedDoc);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(1000);
    // Thousands of unpairable blocks can only be a whole-document review.
    expect(diff.granularity).toBe("whole-document");
  });
});
