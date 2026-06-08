import { useNavigate, useRouter } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { ProseDiff } from "@/components/diff/Diff";
import { Markdown } from "@/components/markdown/Markdown";
import { Button } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { AbsoluteTime } from "@/components/ui/DateTime";
import { Segmented } from "@/components/ui/Segmented";
import { showToast } from "@/components/ui/Toast";
import type { ProjectId } from "@/ids";
import { lineDiff } from "@/lib/diff";
import { useSubmit } from "@/lib/forms";
import {
  type DocSnapshot,
  type DocVersionEntry,
  saveDocument,
} from "@/lib/server/documents";

// Author for display: the control-plane-resolved name when present, the
// "import" sentinel as a readable label, otherwise nothing (a raw user id
// or the empty "no user" sentinel is noise, not provenance).
function authorOf(e: Readonly<DocVersionEntry>): string | undefined {
  if (e.changedByName !== undefined) return e.changedByName;
  if (e.changedBy === "import") return "Imported";
  return undefined;
}

// Version history: the chain newest-first, each version viewable rendered
// and diffable against the current head. Restoring an older version writes
// its content as a NEW version (non-destructive; the chain — and comment
// anchors, via the save path — carry forward). This is the body of the
// document page's "Versions" tab — the page owns the title, the version
// chip and the tab bar, so this renders content only.
export function DocumentHistory({
  current,
  entries,
  projectId,
}: Readonly<{
  current: DocSnapshot;
  entries: readonly DocVersionEntry[];
  projectId: ProjectId;
}>): React.ReactElement {
  const [picked, setPicked] = useState<number>();
  const [view, setView] = useState<"changes" | "rendered">("changes");
  const router = useRouter();
  const navigate = useNavigate();

  const active =
    entries.find((e) => e.docVersion === picked) ?? entries[1] ?? entries[0];

  const diff = useMemo(
    () => (active ? lineDiff(active.markdown, current.markdown) : []),
    [active, current.markdown],
  );

  const { pending: restoring, run: restore } = useSubmit(
    async (entry: DocVersionEntry) => {
      const ok = await confirmDialog({
        title: `Restore v${entry.docVersion.toString()}?`,
        body: "This creates a new version with that version's content. Nothing is lost — the current version stays in history.",
        confirmLabel: "Restore",
      });
      if (!ok) return;
      const r = await saveDocument({
        data: {
          projectId,
          slug: current.slug,
          title: current.title,
          markdown: entry.markdown,
          clientVersion: current.docVersion,
        },
      });
      if (!r.ok) {
        throw new Error(
          "conflict" in r
            ? "The document changed — reopen history and try again."
            : "Restore failed — please retry.",
        );
      }
      showToast(`Restored v${entry.docVersion.toString()}`);
      await router.invalidate();
      await navigate({
        to: "/p/$projectId/documents/$slug",
        params: { projectId, slug: current.slug },
      });
    },
  );

  if (active === undefined) {
    return <p className="text-base text-slate-500">No history yet.</p>;
  }

  const isCurrent = active.docVersion === current.docVersion;
  const showDiff = view === "changes" && !isCurrent && active.retained;

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="min-w-0">
        <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
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
            <div className="flex flex-wrap items-center gap-3">
              <Segmented
                ariaLabel="History view"
                value={view}
                onChange={setView}
                options={[
                  { value: "changes", label: "Changes" },
                  { value: "rendered", label: "Rendered" },
                ]}
              />
              <Button
                variant="secondary"
                className="shrink-0"
                disabled={restoring}
                onClick={() => void restore(active)}
              >
                Restore this version
              </Button>
            </div>
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

      <aside className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-auto lg:pr-1">
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
      </aside>
    </div>
  );
}
