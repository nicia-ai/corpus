import { describe, expect, it } from "vitest";

import { changedBlockIndexes } from "../src/lib/changed-blocks";
import { parseBlocksWithRanges } from "../src/store/domain/block-parse";

function blocks(markdown: string) {
  return parseBlocksWithRanges(markdown).map((block, index) => ({
    index,
    kind: block.kind,
    text: block.text,
  }));
}

describe("changedBlockIndexes", () => {
  it("marks only the changed replacement block", () => {
    const before = "# Brief\n\nKeep this.\n\nOld risk paragraph.\n\nKeep tail.";
    const after = "# Brief\n\nKeep this.\n\nNew risk paragraph.\n\nKeep tail.";

    expect(changedBlockIndexes(before, blocks(after))).toEqual([2]);
  });

  it("marks inserted blocks without flashing unchanged trailing text", () => {
    const before = "# Brief\n\nKeep this.\n\nKeep tail.";
    const after =
      "# Brief\n\nKeep this.\n\nNew customer paragraph.\n\nKeep tail.";

    expect(changedBlockIndexes(before, blocks(after))).toEqual([2]);
  });

  it("uses the next surviving block as the cue for a deletion", () => {
    const before = "# Brief\n\nKeep this.\n\nRemove this.\n\nKeep tail.";
    const after = "# Brief\n\nKeep this.\n\nKeep tail.";

    expect(changedBlockIndexes(before, blocks(after))).toEqual([2]);
  });

  it("cues the last surviving block when the tail is deleted", () => {
    const before = "# Brief\n\nKeep this.\n\nKeep tail.\n\nDrop me.";
    const after = "# Brief\n\nKeep this.\n\nKeep tail.";

    expect(changedBlockIndexes(before, blocks(after))).toEqual([2]);
  });
});
