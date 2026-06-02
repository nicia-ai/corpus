// Tiny line-level diff for the non-engineer prose view: a rendered prose
// diff, not a raw unified patch. Returns lines tagged
// added | removed | same for inline highlight.
export type DiffLine = Readonly<{
  tag: "same" | "added" | "removed";
  text: string;
}>;

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const aSet = new Set(a);
  const bSet = new Set(b);
  const out: DiffLine[] = [];
  for (const line of b) {
    out.push({ tag: aSet.has(line) ? "same" : "added", text: line });
  }
  for (const line of a) {
    if (!bSet.has(line)) out.push({ tag: "removed", text: line });
  }
  return out;
}
