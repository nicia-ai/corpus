import type { DiffLine } from "@nicia-ai/prose-diff";

// Line-level diff rendering shared by the save-conflict merge and the
// version-history compare. `DiffPanel` is the raw side-by-side source pane
// the conflict view puts a "theirs"/"yours" column in.
export function ProseDiff({
  lines,
}: Readonly<{ lines: readonly DiffLine[] }>): React.ReactElement {
  return (
    <div className="space-y-0.5 text-base">
      {lines.map((l, i) => (
        <div
          key={`${String(i)}:${l.tag}:${l.text}`}
          className={
            l.tag === "added"
              ? "bg-green-50 text-green-800"
              : l.tag === "removed"
                ? "bg-red-50 text-red-700 line-through"
                : "text-slate-700"
          }
        >
          {l.text || " "}
        </div>
      ))}
    </div>
  );
}

export function DiffPanel({
  title,
  children,
}: Readonly<{ title: string; children: string }>): React.ReactElement {
  return (
    <div className="rounded-md border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-3 py-2 text-sm font-medium text-slate-500">
        {title}
      </div>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap px-3 py-2 text-base">
        {children}
      </pre>
    </div>
  );
}
