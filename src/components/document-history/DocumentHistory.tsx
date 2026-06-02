import { useMemo, useState } from "react";

import { ProseDiff } from "@/components/diff/Diff";
import { Markdown } from "@/components/markdown/Markdown";
import { AbsoluteTime } from "@/components/ui/DateTime";
import { Segmented } from "@/components/ui/Segmented";
import { lineDiff } from "@/lib/diff";
import type { DocSnapshot, DocVersionEntry } from "@/lib/server/documents";

// Author for display: the control-plane-resolved name when present, the
// "import" sentinel as a readable label, otherwise nothing (a raw user id
// or the empty "no user" sentinel is noise, not provenance).
function authorOf(e: Readonly<DocVersionEntry>): string | undefined {
  if (e.changedByName !== undefined) return e.changedByName;
  if (e.changedBy === "import") return "Imported";
  return undefined;
}

// Read-only version history: the chain newest-first, each version viewable
// rendered and diffable against the current head (the common "what changed
// since vN" question). Restore is intentionally out of scope here. This is
// the body of the document page's "Versions" tab — the page owns the title,
// the version chip and the tab bar, so this renders content only.
export function DocumentHistory({
  current,
  entries,
}: Readonly<{
  current: DocSnapshot;
  entries: readonly DocVersionEntry[];
}>): React.ReactElement {
  const [picked, setPicked] = useState<number>();
  const [view, setView] = useState<"changes" | "rendered">("changes");

  const active =
    entries.find((e) => e.docVersion === picked) ?? entries[1] ?? entries[0];

  const diff = useMemo(
    () => (active ? lineDiff(active.markdown, current.markdown) : []),
    [active, current.markdown],
  );

  if (active === undefined) {
    return <p className="text-base text-slate-500">No history yet.</p>;
  }

  const isCurrent = active.docVersion === current.docVersion;
  const showDiff = view === "changes" && !isCurrent && active.retained;

  return (
    <div className="grid grid-cols-[16rem_1fr] gap-6">
      <ol className="space-y-1">
        {entries.map((e) => {
          const on = e.docVersion === active.docVersion;
          const isCurrentEntry = e.docVersion === current.docVersion;
          const who = authorOf(e);
          const ariaLabel = [
            `v${String(e.docVersion)}`,
            isCurrentEntry ? "(current)" : null,
            who === undefined ? null : `by ${who}`,
          ]
            .filter((s): s is string => s !== null)
            .join(" ");
          return (
            <li key={e.docVersion}>
              <button
                onClick={() => setPicked(e.docVersion)}
                aria-label={ariaLabel}
                aria-current={on ? "true" : undefined}
                className={
                  on
                    ? "w-full rounded-md border border-blue-600 bg-blue-50 px-3 py-2 text-left"
                    : "w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-left hover:bg-slate-50"
                }
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-base font-medium">
                    v{e.docVersion}
                    {e.docVersion === current.docVersion && (
                      <span className="ml-2 text-sm font-normal text-slate-500">
                        current
                      </span>
                    )}
                  </span>
                  <AbsoluteTime
                    iso={e.changedAt}
                    className="shrink-0 text-sm text-slate-500 tabular-nums"
                  />
                </div>
                {authorOf(e) && (
                  <div className="mt-0.5 truncate text-sm text-slate-500">
                    {authorOf(e)}
                  </div>
                )}
                {e.diffSummary && (
                  <div className="mt-1 text-sm text-slate-600">
                    {e.diffSummary}
                  </div>
                )}
              </button>
            </li>
          );
        })}
      </ol>

      <div>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <div className="text-base text-slate-500">
              {isCurrent
                ? `v${active.docVersion} — current version`
                : `v${active.docVersion} vs current (v${current.docVersion})`}
            </div>
            {authorOf(active) && (
              <div className="mt-0.5 text-sm text-slate-500">
                <AbsoluteTime iso={active.changedAt} /> · {authorOf(active)}
              </div>
            )}
          </div>
          {!isCurrent && active.retained && (
            <Segmented
              ariaLabel="History view"
              value={view}
              onChange={setView}
              options={[
                { value: "changes", label: "Changes" },
                { value: "rendered", label: "Rendered" },
              ]}
            />
          )}
        </div>

        {!active.retained ? (
          <p className="rounded-md border border-slate-200 bg-white px-4 py-3 text-base text-slate-500">
            This version’s content is no longer retained.
          </p>
        ) : showDiff ? (
          <div className="rounded-md border border-slate-200 bg-white p-3">
            <ProseDiff lines={diff} />
          </div>
        ) : (
          <Markdown source={active.markdown} />
        )}
      </div>
    </div>
  );
}
