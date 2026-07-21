import { diffSequences, parseBlocksWithRanges } from "@nicia-ai/prose-diff";

type ComparableBlock = Readonly<{
  index: number;
  kind: string;
  text: string;
}>;

// `kind` is a fixed enum of single tokens (no whitespace), so the space
// cannot straddle the kind/text boundary — the joined key is collision-free.
function keyOf(block: Pick<ComparableBlock, "kind" | "text">): string {
  return `${block.kind} ${block.text}`;
}

// Compare the visible markdown blocks before/after a remote write and return
// the block indexes in the new document worth flashing. This is intentionally
// block-level: the cue is "look here", while the review rail/diff carries the
// exact text. Runs on the shared LCS engine in `diff.ts` so the change-flash
// and the prose diff never disagree about what changed.
export function changedBlockIndexes(
  beforeMarkdown: string,
  afterBlocks: readonly ComparableBlock[],
): readonly number[] {
  const a = parseBlocksWithRanges(beforeMarkdown).map(keyOf);
  const b = afterBlocks.map(keyOf);
  const changed = new Set<number>();

  // A deletion paints no new text; cue the surviving block at the deletion
  // point, or the last surviving block when the tail itself was removed (a
  // trailing deletion leaves `bIndex === b.length`, so there is no block at
  // the cursor).
  const cueForRemoval = (bIndex: number): void => {
    const block = afterBlocks[bIndex] ?? afterBlocks[afterBlocks.length - 1];
    if (block !== undefined) changed.add(block.index);
  };

  for (const op of diffSequences(a.length, b.length, (i, j) => a[i] === b[j])) {
    if (op.tag === "added") {
      const block = afterBlocks[op.bIndex];
      if (block !== undefined) changed.add(block.index);
    } else if (op.tag === "removed") {
      cueForRemoval(op.bIndex);
    }
  }

  return [...changed];
}
