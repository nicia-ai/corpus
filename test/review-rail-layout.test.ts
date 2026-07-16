import { describe, expect, it } from "vitest";

import { placeReviewRailItems } from "../src/lib/review-rail-layout";

describe("review rail placement", () => {
  it("preserves document anchors when cards have enough space", () => {
    expect(
      placeReviewRailItems(
        [
          { id: "first", anchorTop: 20, height: 80 },
          { id: "second", anchorTop: 140, height: 50 },
        ],
        12,
      ),
    ).toEqual([
      { id: "first", top: 20, bottom: 100 },
      { id: "second", top: 140, bottom: 190 },
    ]);
  });

  it("pushes later cards below a growing conversation", () => {
    expect(
      placeReviewRailItems(
        [
          { id: "second", anchorTop: 80, height: 60 },
          { id: "first", anchorTop: 20, height: 140 },
        ],
        12,
      ),
    ).toEqual([
      { id: "first", top: 20, bottom: 160 },
      { id: "second", top: 172, bottom: 232 },
    ]);
  });
});
