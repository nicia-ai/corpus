// Tiny line-level diff for the non-engineer prose view: a rendered prose
// diff, not a raw unified patch. Returns lines tagged
// added | removed | same for inline highlight.
export type DiffLine = Readonly<{
  tag: "same" | "added" | "removed";
  text: string;
}>;

// One step of the longest-common-subsequence walk. `aIndex`/`bIndex` are the
// cursor positions when the op was emitted: a "same" consumes a[aIndex] and
// b[bIndex]; a "removed" consumes a[aIndex] (bIndex is the surviving b cursor,
// = b.length past a trailing deletion); an "added" consumes b[bIndex].
export type DiffOp = Readonly<{
  tag: "same" | "removed" | "added";
  aIndex: number;
  bIndex: number;
}>;

// The shared LCS engine. Generic over the element comparison so both the
// prose line diff and the block-level change-flash run one algorithm instead
// of two hand-rolled copies. `equal(i, j)` compares a[i] to b[j].
export function diffSequences(
  aLength: number,
  bLength: number,
  equal: (i: number, j: number) => boolean,
): DiffOp[] {
  const suffixMatches = Array.from({ length: aLength + 1 }, () =>
    Array<number>(bLength + 1).fill(0),
  );
  const matchCount = (i: number, j: number): number =>
    suffixMatches[i]?.[j] ?? 0;

  for (let i = aLength - 1; i >= 0; i -= 1) {
    for (let j = bLength - 1; j >= 0; j -= 1) {
      const row = suffixMatches[i];
      if (row === undefined) continue;
      row[j] = equal(i, j)
        ? matchCount(i + 1, j + 1) + 1
        : Math.max(matchCount(i + 1, j), matchCount(i, j + 1));
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < aLength && j < bLength) {
    if (equal(i, j)) {
      ops.push({ tag: "same", aIndex: i, bIndex: j });
      i += 1;
      j += 1;
    } else if (matchCount(i + 1, j) >= matchCount(i, j + 1)) {
      ops.push({ tag: "removed", aIndex: i, bIndex: j });
      i += 1;
    } else {
      ops.push({ tag: "added", aIndex: i, bIndex: j });
      j += 1;
    }
  }
  while (i < aLength) {
    ops.push({ tag: "removed", aIndex: i, bIndex: j });
    i += 1;
  }
  while (j < bLength) {
    ops.push({ tag: "added", aIndex: i, bIndex: j });
    j += 1;
  }
  return ops;
}

function lineAt(lines: readonly string[], index: number): string {
  return lines[index] ?? "";
}

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  return diffSequences(
    a.length,
    b.length,
    (i, j) => lineAt(a, i) === lineAt(b, j),
  ).map((op) =>
    op.tag === "removed"
      ? { tag: "removed", text: lineAt(a, op.aIndex) }
      : op.tag === "added"
        ? { tag: "added", text: lineAt(b, op.bIndex) }
        : { tag: "same", text: lineAt(a, op.aIndex) },
  );
}
