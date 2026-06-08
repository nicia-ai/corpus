import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Markdown } from "@/components/markdown/Markdown";
import {
  ReviewRail,
  type ReviewRailLayout,
} from "@/components/review/ReviewRail";
import { Button } from "@/components/ui/Button";
import { focusableIn } from "@/components/ui/dialog-focus";
import { Card } from "@/components/ui/Surface";
import type { ProjectId } from "@/ids";
import { cn } from "@/lib/cn";
import { useSubmit } from "@/lib/forms";
import {
  applyReviewHighlights,
  clearHighlights,
  measureAnchorTops,
  resolveSelectionAnchor,
  type AnchorPositionTarget,
} from "@/lib/highlight";
import type { ReviewModel } from "@/lib/review-items";
import {
  createComment,
  type BlockView,
  type CommentsResult,
} from "@/lib/server/comments";
import type { SuggestionsResult } from "@/lib/server/suggestions";
import type { PresenceUser } from "@/lib/use-collab";

type Pending = Readonly<{
  text: string;
  blockIndex: number;
  start: number;
  end: number;
  sourceStart: number;
  sourceEnd: number;
  top: number;
  left: number;
}>;

type Mode = "menu" | "comment" | "suggest";

const EMPTY_REVIEW_LAYOUT: ReviewRailLayout = {
  itemTops: {},
  documentHeight: 0,
};

export function ReviewWorkspace({
  projectId,
  slug,
  markdown,
  docVersion,
  blocks,
  comments,
  suggestions,
  model,
  presence,
  showReview,
  mobileOpen,
  onMobileOpenChange,
  onChange,
  onSuggest,
}: Readonly<{
  projectId: ProjectId;
  slug: string;
  markdown: string;
  docVersion: number;
  blocks: readonly BlockView[];
  comments: CommentsResult;
  suggestions: SuggestionsResult;
  model: ReviewModel;
  presence: readonly PresenceUser[];
  showReview: boolean;
  mobileOpen: boolean;
  onMobileOpenChange: (open: boolean) => void;
  onChange: () => void;
  onSuggest: (proposedMarkdown: string) => Promise<string | undefined>;
}>): React.ReactElement {
  const mobileDialogRef = useRef<HTMLDivElement>(null);
  const mobileCloseRef = useRef<HTMLButtonElement>(null);
  const restoreMobileFocusRef = useRef<HTMLElement | null>(null);
  const [reviewLayout, setReviewLayout] =
    useState<ReviewRailLayout>(EMPTY_REVIEW_LAYOUT);
  const updateReviewLayout = useCallback((next: ReviewRailLayout): void => {
    setReviewLayout((current) =>
      sameReviewLayout(current, next) ? current : next,
    );
  }, []);

  useEffect(() => {
    if (!mobileOpen) return undefined;
    restoreMobileFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    mobileCloseRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onMobileOpenChange(false);
        return;
      }
      if (event.key !== "Tab" || mobileDialogRef.current === null) return;
      const focusable = focusableIn(mobileDialogRef.current);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      const target = restoreMobileFocusRef.current;
      restoreMobileFocusRef.current = null;
      if (target !== null && document.body.contains(target)) target.focus();
    };
  }, [mobileOpen, onMobileOpenChange]);

  const desktopRail = (
    <ReviewRail
      projectId={projectId}
      items={model.items}
      commentNames={comments.names}
      suggestionNames={suggestions.names}
      baseMarkdown={markdown}
      presence={presence}
      layout={reviewLayout}
      onChange={onChange}
    />
  );

  const mobileRail = (
    <ReviewRail
      projectId={projectId}
      items={model.items}
      commentNames={comments.names}
      suggestionNames={suggestions.names}
      baseMarkdown={markdown}
      presence={presence}
      onChange={onChange}
    />
  );

  return (
    <section className="space-y-3">
      <div
        className={cn(
          "min-w-0",
          showReview
            ? "grid items-start gap-6 lg:grid-cols-[minmax(0,54rem)_20rem] xl:gap-8"
            : "mx-auto max-w-[54rem]",
        )}
      >
        <AnnotatableMarkdown
          projectId={projectId}
          slug={slug}
          markdown={markdown}
          docVersion={docVersion}
          blocks={blocks}
          comments={comments}
          suggestionMarks={model.inlineSuggestionMarks}
          onReviewLayoutChange={updateReviewLayout}
          onChange={onChange}
          onSuggest={onSuggest}
        />
        {showReview && <div className="hidden lg:block">{desktopRail}</div>}
      </div>
      {mobileOpen && showReview && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close review"
            className="absolute inset-0 bg-slate-900/30"
            onClick={() => onMobileOpenChange(false)}
          />
          <div
            ref={mobileDialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Document review"
            className="absolute inset-x-0 bottom-0 max-h-[82vh] overflow-auto rounded-t-lg border border-slate-200 bg-white p-4 shadow-xl"
          >
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-medium tracking-wide text-slate-500 uppercase">
                Review
              </div>
              <button
                ref={mobileCloseRef}
                type="button"
                aria-label="Close review"
                onClick={() => onMobileOpenChange(false)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {mobileRail}
          </div>
        </div>
      )}
    </section>
  );
}

function reviewAnchorTargets(
  threads: CommentsResult["threads"],
  suggestionMarks: ReviewModel["inlineSuggestionMarks"],
): readonly AnchorPositionTarget[] {
  const targets: AnchorPositionTarget[] = threads.map((thread) => ({
    id: `comment:${thread.id}`,
    anchor: {
      blockId: thread.anchorBlockId,
      start: thread.anchorStart,
      end: thread.anchorEnd,
      quote: thread.quote,
    },
  }));
  const seenSuggestions = new Set<number>();
  for (const mark of suggestionMarks) {
    if (seenSuggestions.has(mark.suggestionId)) continue;
    seenSuggestions.add(mark.suggestionId);
    targets.push({
      id: `suggestion:${mark.suggestionId}`,
      anchor: mark.anchor,
    });
  }
  return targets;
}

function sameReviewLayout(a: ReviewRailLayout, b: ReviewRailLayout): boolean {
  if (a.documentHeight !== b.documentHeight) return false;
  const aKeys = Object.keys(a.itemTops);
  const bKeys = Object.keys(b.itemTops);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a.itemTops[key] === b.itemTops[key]);
}

function AnnotatableMarkdown({
  projectId,
  slug,
  markdown,
  docVersion,
  blocks,
  comments,
  suggestionMarks,
  onReviewLayoutChange,
  onChange,
  onSuggest,
}: Readonly<{
  projectId: ProjectId;
  slug: string;
  markdown: string;
  docVersion: number;
  blocks: readonly BlockView[];
  comments: CommentsResult;
  suggestionMarks: ReviewModel["inlineSuggestionMarks"];
  onReviewLayoutChange: (layout: ReviewRailLayout) => void;
  onChange: () => void;
  onSuggest: (proposedMarkdown: string) => Promise<string | undefined>;
}>): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const proseRef = useRef<HTMLDivElement>(null);
  const selectionFrameRef = useRef<number | undefined>(undefined);
  const selectionTimerRef = useRef<number | undefined>(undefined);
  const modeRef = useRef<Mode>("menu");
  const [pending, setPending] = useState<Pending>();
  const [mode, setMode] = useState<Mode>("menu");
  const [body, setBody] = useState("");
  const [edited, setEdited] = useState("");

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  function cancelScheduledSelectionCapture(): void {
    if (selectionFrameRef.current !== undefined) {
      cancelAnimationFrame(selectionFrameRef.current);
      selectionFrameRef.current = undefined;
    }
    if (selectionTimerRef.current !== undefined) {
      window.clearTimeout(selectionTimerRef.current);
      selectionTimerRef.current = undefined;
    }
  }

  useEffect(() => {
    const prose = proseRef.current;
    const frame = containerRef.current;
    if (prose === null) return undefined;
    const targets = reviewAnchorTargets(comments.threads, suggestionMarks);
    const measure = (): void => {
      if (frame === null) return;
      onReviewLayoutChange({
        itemTops: measureAnchorTops({
          container: prose,
          frame,
          targets,
          blocks,
        }),
        documentHeight: Math.ceil(frame.scrollHeight),
      });
    };
    applyReviewHighlights({
      container: prose,
      comments: comments.threads
        .filter((t) => t.status === "open")
        .map((t) => ({
          blockId: t.anchorBlockId,
          start: t.anchorStart,
          end: t.anchorEnd,
          quote: t.quote,
        })),
      suggestions: suggestionMarks,
      blocks,
    });
    measure();
    let frameId: number | undefined;
    const scheduleMeasure = (): void => {
      if (frameId !== undefined) cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        frameId = undefined;
        measure();
      });
    };
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(scheduleMeasure);
    observer?.observe(prose);
    if (frame !== null) observer?.observe(frame);
    window.addEventListener("resize", scheduleMeasure);
    return () => {
      clearHighlights();
      observer?.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      if (frameId !== undefined) cancelAnimationFrame(frameId);
    };
  }, [
    blocks,
    comments.threads,
    markdown,
    onReviewLayoutChange,
    suggestionMarks,
  ]);

  useEffect(
    () => () => {
      cancelScheduledSelectionCapture();
    },
    [],
  );

  const {
    pending: saving,
    error: commentError,
    run: create,
  } = useSubmit(async (p: Pending, text: string) => {
    const r = await createComment({
      data: {
        projectId,
        slug,
        blockIndex: p.blockIndex,
        start: p.start,
        end: p.end,
        body: text,
        clientVersion: docVersion,
      },
    });
    if (!r.ok) {
      throw new Error(
        r.reason === "conflict"
          ? "The document changed; reload and try again."
          : "Could not add the comment.",
      );
    }
    reset();
    onChange();
  });

  const {
    pending: suggesting,
    error: suggestError,
    run: suggest,
  } = useSubmit(async (p: Pending, source: string) => {
    const proposed =
      markdown.slice(0, p.sourceStart) + source + markdown.slice(p.sourceEnd);
    const message = await onSuggest(proposed);
    if (message !== undefined) throw new Error(message);
    reset();
  });

  function reset(): void {
    cancelScheduledSelectionCapture();
    setPending(undefined);
    setMode("menu");
    setBody("");
    setEdited("");
    window.getSelection()?.removeAllRanges();
  }

  function scheduleSelectionCapture(
    event: React.MouseEvent<HTMLDivElement>,
    delayMs = 0,
  ): void {
    if (modeRef.current !== "menu") return;
    const prose = proseRef.current;
    if (
      prose === null ||
      !(event.target instanceof Node) ||
      !prose.contains(event.target)
    ) {
      return;
    }
    cancelScheduledSelectionCapture();
    if (delayMs === 0) {
      selectionFrameRef.current = requestAnimationFrame(captureSelection);
      return;
    }
    selectionTimerRef.current = window.setTimeout(() => {
      selectionTimerRef.current = undefined;
      selectionFrameRef.current = requestAnimationFrame(captureSelection);
    }, delayMs);
  }

  function scheduleMultiClickSelectionCapture(
    event: React.MouseEvent<HTMLDivElement>,
  ): void {
    if (event.detail < 2) return;
    scheduleSelectionCapture(event, 30);
  }

  function captureSelection(): void {
    selectionFrameRef.current = undefined;
    if (modeRef.current !== "menu") return;
    const selection = window.getSelection();
    const prose = proseRef.current;
    const container = containerRef.current;
    if (
      selection === null ||
      selection.rangeCount === 0 ||
      selection.toString().trim() === "" ||
      prose === null ||
      container === null
    ) {
      setPending(undefined);
      return;
    }
    const range = selection.getRangeAt(0);
    if (!prose.contains(range.commonAncestorContainer)) {
      setPending(undefined);
      return;
    }
    const anchor = resolveSelectionAnchor(prose, range, blocks);
    if (anchor === undefined) {
      setPending(undefined);
      return;
    }
    const rect = range.getBoundingClientRect();
    const cRect = container.getBoundingClientRect();
    setPending({
      text: anchor.exact,
      blockIndex: anchor.blockIndex,
      start: anchor.start,
      end: anchor.end,
      sourceStart: anchor.sourceStart,
      sourceEnd: anchor.sourceEnd,
      top: rect.bottom - cRect.top,
      left: rect.left - cRect.left,
    });
  }

  function handleComposerKeyDown(
    event: React.KeyboardEvent<HTMLTextAreaElement>,
    onSubmit: () => void,
    disabled: boolean,
  ): void {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      reset();
      return;
    }
    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    if (!disabled) onSubmit();
  }

  function submitComment(p: Pending): void {
    const text = body.trim();
    if (saving || text === "") return;
    void create(p, text);
  }

  function submitSuggestion(p: Pending): void {
    if (suggesting || edited.trim() === "") return;
    void suggest(p, edited);
  }

  return (
    <div
      ref={containerRef}
      className="relative min-w-0"
      onMouseUp={scheduleSelectionCapture}
      onClick={scheduleMultiClickSelectionCapture}
    >
      <div ref={proseRef}>
        <Markdown source={markdown} />
      </div>
      {pending !== undefined && (
        <div
          className="absolute z-10 max-w-[calc(100vw-2rem)]"
          style={{ top: pending.top + 6, left: pending.left }}
        >
          {mode === "menu" && (
            <div className="flex gap-1 rounded-md border border-slate-200 bg-white p-1 shadow-sm">
              <PopoverAction
                onClick={() => setMode("comment")}
                label="Comment"
              />
              <PopoverAction
                onClick={() => {
                  setEdited(
                    markdown.slice(pending.sourceStart, pending.sourceEnd),
                  );
                  setMode("suggest");
                }}
                label="Suggest edit"
              />
            </div>
          )}
          {mode === "comment" && (
            <Card className="w-72 space-y-2 p-3 shadow-md">
              <Quote text={pending.text} />
              <textarea
                autoFocus
                value={body}
                onChange={(e) => setBody(e.target.value)}
                onKeyDown={(e) =>
                  handleComposerKeyDown(
                    e,
                    () => submitComment(pending),
                    saving || body.trim() === "",
                  )
                }
                rows={3}
                placeholder="Add a comment..."
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
              />
              <Actions
                submitLabel="Comment"
                disabled={saving || body.trim() === ""}
                onSubmit={() => void create(pending, body.trim())}
                onCancel={reset}
                error={commentError}
              />
            </Card>
          )}
          {mode === "suggest" && (
            <Card className="w-80 space-y-2 p-3 shadow-md">
              <div className="text-sm text-slate-500">Propose an edit</div>
              <textarea
                autoFocus
                value={edited}
                onChange={(e) => setEdited(e.target.value)}
                onKeyDown={(e) =>
                  handleComposerKeyDown(
                    e,
                    () => submitSuggestion(pending),
                    suggesting || edited.trim() === "",
                  )
                }
                rows={4}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 font-mono text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
              />
              <Actions
                submitLabel="Suggest"
                disabled={suggesting || edited.trim() === ""}
                onSubmit={() => void suggest(pending, edited)}
                onCancel={reset}
                error={suggestError}
              />
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function PopoverAction({
  onClick,
  label,
}: Readonly<{ onClick: () => void; label: string }>): React.ReactElement {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="rounded-sm px-2 py-1 text-sm font-medium text-blue-600 hover:bg-slate-50"
    >
      {label}
    </button>
  );
}

function Quote({ text }: Readonly<{ text: string }>): React.ReactElement {
  return (
    <div className="line-clamp-2 border-l-2 border-slate-200 pl-2 text-sm text-slate-500">
      {text}
    </div>
  );
}

function Actions({
  submitLabel,
  disabled,
  onSubmit,
  onCancel,
  error,
}: Readonly<{
  submitLabel: string;
  disabled: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  error: string | undefined;
}>): React.ReactElement {
  return (
    <div className="flex items-center gap-2">
      <Button type="button" disabled={disabled} onClick={onSubmit}>
        {submitLabel}
      </Button>
      <Button type="button" variant="secondary" onClick={onCancel}>
        Cancel
      </Button>
      {error !== undefined && (
        <span className="text-sm text-red-600">{error}</span>
      )}
    </div>
  );
}
