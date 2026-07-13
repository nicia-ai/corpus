// Sticky bottom action chrome shared by the create and edit document
// surfaces. Pinned to the BOTTOM so it never shifts the editor above it.
// Buttons/labels are caller-owned (Save/Discard/Suggest vs. a single Create
// differ enough to stay per-page) — this owns only the wrapper and the
// broken-link count, which were byte-identical duplicates between the two
// pages.
export function DocumentActionBar({
  broken,
  error,
  children,
}: Readonly<{
  broken: number;
  error?: React.ReactNode;
  children: React.ReactNode;
}>): React.ReactElement {
  return (
    <div className="sticky bottom-0 z-20 mt-4 flex flex-wrap items-center gap-3 border-t border-slate-200 bg-white py-3">
      {children}
      {broken > 0 && (
        <span className="text-sm text-amber-700">
          {broken} link{broken > 1 ? "s" : ""} to a missing document
        </span>
      )}
      {error}
    </div>
  );
}
