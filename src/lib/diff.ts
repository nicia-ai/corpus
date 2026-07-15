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

// Keep the synchronous path comfortably below a frame-sized allocation. A
// prose diff does not need a perfect edit script for two enormous, unrelated
// documents; preserving their common prefix/suffix and treating the bounded
// middle as replace-all is both honest and dramatically safer than allocating
// an unbounded (N + 1) x (M + 1) matrix on the main thread.
const MAX_LCS_CELLS = 250_000;

// The shared LCS engine. Generic over the element comparison so both the
// prose line diff and the block-level change-flash run one algorithm instead
// of two hand-rolled copies. `equal(i, j)` compares a[i] to b[j].
export function diffSequences(
  aLength: number,
  bLength: number,
  equal: (i: number, j: number) => boolean,
): DiffOp[] {
  let prefix = 0;
  while (prefix < aLength && prefix < bLength && equal(prefix, prefix)) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < aLength - prefix &&
    suffix < bLength - prefix &&
    equal(aLength - suffix - 1, bLength - suffix - 1)
  ) {
    suffix += 1;
  }

  const middleALength = aLength - prefix - suffix;
  const middleBLength = bLength - prefix - suffix;
  const ops: DiffOp[] = Array.from({ length: prefix }, (_, index) => ({
    tag: "same" as const,
    aIndex: index,
    bIndex: index,
  }));
  if (middleALength * middleBLength > MAX_LCS_CELLS) {
    for (let i = 0; i < middleALength; i += 1) {
      ops.push({ tag: "removed", aIndex: prefix + i, bIndex: prefix });
    }
    for (let j = 0; j < middleBLength; j += 1) {
      ops.push({
        tag: "added",
        aIndex: prefix + middleALength,
        bIndex: prefix + j,
      });
    }
    appendCommonSuffix(ops, aLength, bLength, suffix);
    return ops;
  }

  const suffixMatches = Array.from({ length: middleALength + 1 }, () =>
    Array<number>(middleBLength + 1).fill(0),
  );
  const matchCount = (i: number, j: number): number =>
    suffixMatches[i]?.[j] ?? 0;

  for (let i = middleALength - 1; i >= 0; i -= 1) {
    for (let j = middleBLength - 1; j >= 0; j -= 1) {
      const row = suffixMatches[i];
      if (row === undefined) continue;
      row[j] = equal(prefix + i, prefix + j)
        ? matchCount(i + 1, j + 1) + 1
        : Math.max(matchCount(i + 1, j), matchCount(i, j + 1));
    }
  }

  let i = 0;
  let j = 0;
  while (i < middleALength && j < middleBLength) {
    if (equal(prefix + i, prefix + j)) {
      ops.push({ tag: "same", aIndex: prefix + i, bIndex: prefix + j });
      i += 1;
      j += 1;
    } else if (matchCount(i + 1, j) >= matchCount(i, j + 1)) {
      ops.push({
        tag: "removed",
        aIndex: prefix + i,
        bIndex: prefix + j,
      });
      i += 1;
    } else {
      ops.push({ tag: "added", aIndex: prefix + i, bIndex: prefix + j });
      j += 1;
    }
  }
  while (i < middleALength) {
    ops.push({
      tag: "removed",
      aIndex: prefix + i,
      bIndex: prefix + j,
    });
    i += 1;
  }
  while (j < middleBLength) {
    ops.push({ tag: "added", aIndex: prefix + i, bIndex: prefix + j });
    j += 1;
  }
  appendCommonSuffix(ops, aLength, bLength, suffix);
  return ops;
}

function appendCommonSuffix(
  ops: DiffOp[],
  aLength: number,
  bLength: number,
  suffixLength: number,
): void {
  for (let offset = suffixLength; offset > 0; offset -= 1) {
    ops.push({
      tag: "same",
      aIndex: aLength - offset,
      bIndex: bLength - offset,
    });
  }
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
