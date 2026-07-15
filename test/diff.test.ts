import { describe, expect, it } from "vitest";

import { lineDiff } from "../src/lib/diff";

describe("lineDiff", () => {
  it("keeps replacements at their document position", () => {
    expect(
      lineDiff("intro\nold middle\noutro", "intro\nnew middle\noutro"),
    ).toEqual([
      { tag: "same", text: "intro" },
      { tag: "removed", text: "old middle" },
      { tag: "added", text: "new middle" },
      { tag: "same", text: "outro" },
    ]);
  });

  it("keeps deletions next to their surrounding unchanged lines", () => {
    expect(lineDiff("intro\nremoved\noutro", "intro\noutro")).toEqual([
      { tag: "same", text: "intro" },
      { tag: "removed", text: "removed" },
      { tag: "same", text: "outro" },
    ]);
  });

  it("handles duplicate lines without treating every duplicate as unchanged", () => {
    expect(
      lineDiff("alpha\nrepeat\nrepeat\nomega", "alpha\nrepeat\nomega"),
    ).toEqual([
      { tag: "same", text: "alpha" },
      { tag: "same", text: "repeat" },
      { tag: "removed", text: "repeat" },
      { tag: "same", text: "omega" },
    ]);
  });

  it("bounds work for large unrelated middles while preserving shared edges", () => {
    const before = [
      "shared start",
      ...Array.from({ length: 2_000 }, (_, index) => `before ${index}`),
      "shared end",
    ].join("\n");
    const after = [
      "shared start",
      ...Array.from({ length: 2_000 }, (_, index) => `after ${index}`),
      "shared end",
    ].join("\n");

    const result = lineDiff(before, after);
    expect(result[0]).toEqual({ tag: "same", text: "shared start" });
    expect(result.at(-1)).toEqual({ tag: "same", text: "shared end" });
    expect(result.filter((line) => line.tag === "removed")).toHaveLength(2_000);
    expect(result.filter((line) => line.tag === "added")).toHaveLength(2_000);
  });
});
