// Tiny line-level diff for the non-engineer prose view: a rendered prose
// diff, not a raw unified patch. Returns lines tagged
// added | removed | same for inline highlight.
export type DiffLine = Readonly<{
  tag: "same" | "added" | "removed";
  text: string;
}>;

function lineAt(lines: readonly string[], index: number): string {
  return lines[index] ?? "";
}

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const suffixMatches = Array.from({ length: a.length + 1 }, () =>
    Array<number>(b.length + 1).fill(0),
  );
  const matchCount = (i: number, j: number): number =>
    suffixMatches[i]?.[j] ?? 0;

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const row = suffixMatches[i];
      if (row === undefined) continue;
      row[j] =
        lineAt(a, i) === lineAt(b, j)
          ? matchCount(i + 1, j + 1) + 1
          : Math.max(matchCount(i + 1, j), matchCount(i, j + 1));
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    const beforeLine = lineAt(a, i);
    const afterLine = lineAt(b, j);

    if (beforeLine === afterLine) {
      out.push({ tag: "same", text: beforeLine });
      i += 1;
      j += 1;
    } else if (matchCount(i + 1, j) >= matchCount(i, j + 1)) {
      out.push({ tag: "removed", text: beforeLine });
      i += 1;
    } else {
      out.push({ tag: "added", text: afterLine });
      j += 1;
    }
  }

  while (i < a.length) {
    out.push({ tag: "removed", text: lineAt(a, i) });
    i += 1;
  }

  while (j < b.length) {
    out.push({ tag: "added", text: lineAt(b, j) });
    j += 1;
  }

  return out;
}
