import { useNavigate, useRouter } from "@tanstack/react-router";
import {
  ChevronDown,
  ChevronUp,
  Eye,
  GitCompareArrows,
  RotateCcw,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  DOCUMENT_BODY_CLASS,
  MarkdownContent,
} from "@/components/markdown/Markdown";
import { MarkdownEditor } from "@/components/markdown/MarkdownEditor";
import { Button } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { AbsoluteTime } from "@/components/ui/DateTime";
import { Segmented } from "@/components/ui/Segmented";
import { cardClass } from "@/components/ui/Surface";
import { showToast } from "@/components/ui/Toast";
import type { ProjectId } from "@/ids";
import { cn } from "@/lib/cn";
import { lineDiff, type DiffLine } from "@/lib/diff";
import { useSubmit } from "@/lib/forms";
import {
  type DocSnapshot,
  type DocVersionEntry,
  saveDocument,
} from "@/lib/server/documents";
import { useFollowDocLink } from "@/lib/use-follow-doc-link";

const CHANGE_PREVIEW_LIMIT = 8;

type HistoryView = "version" | "compare";

type CompareSection = Readonly<
  | { kind: "same"; lines: readonly DiffLine[] }
  | { kind: "change"; changeIndex: number; lines: readonly DiffLine[] }
>;

// Author for display: the control-plane-resolved name when present, the
// "import" sentinel as a readable label, otherwise nothing (a raw user id
// or the empty "no user" sentinel is noise, not provenance).
function authorOf(e: Readonly<DocVersionEntry>): string | undefined {
  if (e.changedByName !== undefined) return e.changedByName;
  if (e.changedBy === "import") return "Imported";
  return undefined;
}

function changedLines(lines: readonly DiffLine[]): readonly DiffLine[] {
  return lines.filter((line) => line.tag !== "same");
}

function compareSectionsOf(
  lines: readonly DiffLine[],
): readonly CompareSection[] {
  const sections: CompareSection[] = [];
  let currentKind: CompareSection["kind"] | undefined;
  let currentLines: DiffLine[] = [];
  let changeIndex = 0;

  const flush = () => {
    if (currentKind === undefined || currentLines.length === 0) return;
    if (currentKind === "same") {
      sections.push({ kind: "same", lines: currentLines });
    } else {
      sections.push({ kind: "change", changeIndex, lines: currentLines });
      changeIndex += 1;
    }
    currentLines = [];
  };

  for (const line of lines) {
    const nextKind = line.tag === "same" ? "same" : "change";
    if (currentKind !== nextKind) {
      flush();
      currentKind = nextKind;
    }
    currentLines.push(line);
  }

  flush();
  return sections;
}

function changeSectionCount(sections: readonly CompareSection[]): number {
  return sections.filter((section) => section.kind === "change").length;
}

function changeCountLabel(lines: readonly DiffLine[]): string {
  const added = lines.filter((line) => line.tag === "added").length;
  const removed = lines.filter((line) => line.tag === "removed").length;
  const parts: string[] = [];

  if (added > 0) parts.push(`${added.toString()} added`);
  if (removed > 0) parts.push(`${removed.toString()} removed`);

  return parts.length > 0 ? parts.join(" · ") : "No text changes";
}

function VersionChangeSummary({
  activeVersion,
  currentVersion,
  lines,
  onCompare,
}: Readonly<{
  activeVersion: number;
  currentVersion: number;
  lines: readonly DiffLine[];
  onCompare: () => void;
}>): React.ReactElement {
  const preview = lines.slice(0, CHANGE_PREVIEW_LIMIT);
  const hidden = lines.length - preview.length;

  return (
    <section className="mb-4 rounded-md border border-slate-200 bg-white px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-sm font-medium text-slate-500">What changed</div>
          <div className="mt-1 text-base text-slate-700">
            Current v{currentVersion} compared with v{activeVersion}:{" "}
            {changeCountLabel(lines)}
          </div>
        </div>
        {lines.length > 0 && (
          <Button variant="secondary" className="shrink-0" onClick={onCompare}>
            <GitCompareArrows className="size-4" aria-hidden="true" />
            Compare to current
          </Button>
        )}
      </div>

      {preview.length > 0 && (
        <ol className="mt-3 max-h-52 space-y-1 overflow-auto border-t border-slate-200 pt-3 text-base">
          {preview.map((line, index) => {
            const added = line.tag === "added";
            return (
              <li
                key={`${String(index)}:${line.tag}:${line.text}`}
                className={
                  added
                    ? "flex gap-2 rounded bg-green-50 px-2 py-1 text-green-800"
                    : "flex gap-2 rounded bg-red-50 px-2 py-1 text-red-700"
                }
              >
                <span className="w-4 shrink-0 font-medium">
                  {added ? "+" : "-"}
                </span>
                <span className={added ? "" : "line-through"}>
                  {line.text || " "}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {hidden > 0 && (
        <div className="mt-2 text-sm text-slate-500">
          {hidden.toString()} more changed {hidden === 1 ? "line" : "lines"}
        </div>
      )}
    </section>
  );
}

function VersionCompare({
  focusedChangeIndex,
  onChangeRef,
  sections,
}: Readonly<{
  focusedChangeIndex: number;
  onChangeRef: (index: number, node: HTMLDivElement | null) => void;
  sections: readonly CompareSection[];
}>): React.ReactElement {
  return (
    <div className={cardClass(DOCUMENT_BODY_CLASS)}>
      {sections.map((section, index) => {
        if (section.kind === "same") {
          const source = section.lines.map((line) => line.text).join("\n");
          return source.trim() === "" ? (
            <div key={String(index)} className="h-4" />
          ) : (
            <div key={String(index)}>
              <MarkdownContent source={source} />
            </div>
          );
        }

        const focused = section.changeIndex === focusedChangeIndex;
        return (
          <div
            key={String(index)}
            ref={(node) => onChangeRef(section.changeIndex, node)}
            className={cn(
              "my-4 scroll-mt-24 rounded-md border border-amber-200 bg-amber-50/30 px-3 py-2",
              focused && "ring-2 ring-blue-500 ring-offset-2",
            )}
          >
            <div className="mb-2 text-sm font-medium text-amber-800">
              Change {(section.changeIndex + 1).toString()}
            </div>
            <div className="space-y-1.5">
              {section.lines.map((line, lineIndex) => {
                const added = line.tag === "added";
                return (
                  <div
                    key={`${String(lineIndex)}:${line.tag}:${line.text}`}
                    className={cn(
                      "flex gap-2 rounded px-2 py-1.5 [&_h1]:my-0 [&_h2]:my-0 [&_h3]:my-0 [&_h4]:my-0 [&_h5]:my-0 [&_h6]:my-0 [&_ol]:my-0 [&_p]:my-0 [&_ul]:my-0",
                      added
                        ? "bg-green-50 text-green-800"
                        : "bg-red-50 text-red-700 line-through",
                    )}
                  >
                    <span className="w-4 shrink-0 font-medium">
                      {added ? "+" : "-"}
                    </span>
                    <div className="min-w-0 flex-1">
                      {line.text.trim() === "" ? (
                        <span>&nbsp;</span>
                      ) : (
                        <MarkdownContent source={line.text} />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ChangeNavigator({
  count,
  index,
  onNext,
  onPrevious,
}: Readonly<{
  count: number;
  index: number;
  onNext: () => void;
  onPrevious: () => void;
}>): React.ReactElement {
  return (
    <section className="mb-4 rounded-md border border-slate-200 bg-white px-3 py-2">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="text-sm font-medium text-slate-500">Change</div>
        <div className="text-sm text-slate-500 tabular-nums">
          {(index + 1).toString()} / {count.toString()}
        </div>
      </div>
      <div className="flex gap-2">
        <Button
          variant="secondary"
          className="flex size-9 items-center justify-center p-0"
          disabled={index === 0}
          aria-label="Previous change"
          title="Previous change"
          onClick={onPrevious}
        >
          <ChevronUp className="size-4" aria-hidden="true" />
        </Button>
        <Button
          variant="secondary"
          className="flex size-9 items-center justify-center p-0"
          disabled={index >= count - 1}
          aria-label="Next change"
          title="Next change"
          onClick={onNext}
        >
          <ChevronDown className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </section>
  );
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
  const [view, setView] = useState<HistoryView>("version");
  const [focusedChangeIndex, setFocusedChangeIndex] = useState(0);
  const pendingScrollIndex = useRef<number | undefined>(undefined);
  const changeRefs = useRef<(HTMLDivElement | null)[]>([]);
  const router = useRouter();
  const navigate = useNavigate();
  const followLink = useFollowDocLink(projectId);

  const active =
    entries.find((e) => e.docVersion === picked) ?? entries[1] ?? entries[0];

  const diffLines = useMemo(
    () => (active ? lineDiff(active.markdown, current.markdown) : []),
    [active, current.markdown],
  );
  const changedDiffLines = useMemo(() => changedLines(diffLines), [diffLines]);
  const compareSections = useMemo(
    () => compareSectionsOf(diffLines),
    [diffLines],
  );
  const changeCount = useMemo(
    () => changeSectionCount(compareSections),
    [compareSections],
  );
  const focusedChange =
    changeCount === 0 ? 0 : Math.min(focusedChangeIndex, changeCount - 1);
  const isCurrent = active?.docVersion === current.docVersion;
  const showCompare =
    view === "compare" && active !== undefined && !isCurrent && active.retained;

  useEffect(() => {
    changeRefs.current = [];
  }, [active?.docVersion, current.docVersion]);

  useEffect(() => {
    if (!showCompare || pendingScrollIndex.current === undefined) return;
    changeRefs.current[pendingScrollIndex.current]?.scrollIntoView({
      block: "center",
      behavior: "smooth",
    });
    pendingScrollIndex.current = undefined;
  }, [compareSections, showCompare]);

  const { pending: restoring, run: restore } = useSubmit(
    async (entry: DocVersionEntry) => {
      const ok = await confirmDialog({
        title: `Restore v${entry.docVersion.toString()} as current?`,
        body: `This creates v${(current.docVersion + 1).toString()} from v${entry.docVersion.toString()}. Existing versions remain in history.`,
        confirmLabel: `Restore v${entry.docVersion.toString()}`,
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
      showToast(`Restored v${entry.docVersion.toString()} as current`);
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

  const showCompareAt = (index: number) => {
    if (changeCount === 0) return;
    const next = Math.max(0, Math.min(index, changeCount - 1));
    setFocusedChangeIndex(next);
    if (view !== "compare") {
      pendingScrollIndex.current = next;
      setView("compare");
      return;
    }
    changeRefs.current[next]?.scrollIntoView({
      block: "center",
      behavior: "smooth",
    });
  };

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="min-w-0">
        <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="text-base text-slate-500">
              {isCurrent
                ? `v${active.docVersion} — current version`
                : showCompare
                  ? `v${active.docVersion} compared with current v${current.docVersion}`
                  : `Viewing v${active.docVersion}`}
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
                onChange={(next) => {
                  if (next === "compare") {
                    showCompareAt(0);
                  } else {
                    setView(next);
                  }
                }}
                options={[
                  { value: "version", label: "Version", icon: Eye },
                  {
                    value: "compare",
                    label: "Compare",
                    icon: GitCompareArrows,
                  },
                ]}
              />
              <Button
                variant="secondary"
                className="shrink-0"
                disabled={restoring}
                onClick={() => void restore(active)}
              >
                <RotateCcw className="size-4" aria-hidden="true" />
                Restore v{active.docVersion}
              </Button>
            </div>
          )}
        </div>

        {!active.retained ? (
          <p className="rounded-md border border-slate-200 bg-white px-4 py-3 text-base text-slate-500">
            This version’s content is no longer retained.
          </p>
        ) : showCompare ? (
          <VersionCompare
            focusedChangeIndex={focusedChange}
            sections={compareSections}
            onChangeRef={(index, node) => {
              changeRefs.current[index] = node;
            }}
          />
        ) : (
          <>
            {!isCurrent && (
              <VersionChangeSummary
                activeVersion={active.docVersion}
                currentVersion={current.docVersion}
                lines={changedDiffLines}
                onCompare={() => showCompareAt(0)}
              />
            )}
            {/* Read-only live-preview: the SAME renderer as the editor, so the
                viewed version styles prose identically (code syntax highlighting
                is editor-only per DESIGN.md; the CodeMirror surface brings its
                own `.md`-equivalent typography, so this card carries padding
                only, not the `.md` class). Keyed by version so each selection
                mounts clean state. */}
            <div
              className={cardClass(
                "px-6 py-8 sm:px-10 sm:py-10 lg:px-14 lg:py-12",
              )}
            >
              <MarkdownEditor
                key={active.docVersion}
                readOnly
                value={active.markdown}
                ariaLabel={`Version ${active.docVersion} of ${current.title}`}
                onFollowLink={followLink}
              />
            </div>
          </>
        )}
      </div>

      <aside className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-auto lg:pr-1">
        {showCompare && changeCount > 0 && (
          <ChangeNavigator
            count={changeCount}
            index={focusedChange}
            onNext={() => showCompareAt(focusedChange + 1)}
            onPrevious={() => showCompareAt(focusedChange - 1)}
          />
        )}
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
                  onClick={() => {
                    setPicked(e.docVersion);
                    setFocusedChangeIndex(0);
                    if (view === "compare") pendingScrollIndex.current = 0;
                  }}
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
