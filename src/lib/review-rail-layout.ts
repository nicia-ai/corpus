export type ReviewRailPlacementInput = Readonly<{
  id: string;
  anchorTop: number;
  height: number;
}>;

export type ReviewRailPlacement = Readonly<{
  id: string;
  top: number;
  bottom: number;
}>;

// Keep cards aligned with their document anchors when space permits, then
// push later cards down just enough to prevent overlap. Heights come from the
// rendered rail, so replies can grow a card without painting over its neighbor.
export function placeReviewRailItems(
  items: readonly ReviewRailPlacementInput[],
  gap: number,
): readonly ReviewRailPlacement[] {
  let previousBottom: number | undefined;
  return [...items]
    .sort((left, right) => left.anchorTop - right.anchorTop)
    .map((item) => {
      const top =
        previousBottom === undefined
          ? item.anchorTop
          : Math.max(item.anchorTop, previousBottom + gap);
      const bottom = top + item.height;
      previousBottom = bottom;
      return { id: item.id, top, bottom };
    });
}
