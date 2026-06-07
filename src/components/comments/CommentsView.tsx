import { useEffect, useRef, useState } from "react";

import { Markdown } from "@/components/markdown/Markdown";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Surface";
import type { ProjectId } from "@/ids";
import { cn } from "@/lib/cn";
import { useSubmit } from "@/lib/forms";
import {
  applyHighlights,
  clearHighlights,
  resolveSelectionAnchor,
} from "@/lib/highlight";
import {
  addComment,
  type BlockView,
  type CommentStatus,
  type CommentThreadView,
  createComment,
  resolveComment,
} from "@/lib/server/comments";

// Annotating happens in the normal rendered document: select text and a
// popover offers "Comment" (anchors to exactly that selection) or "Suggest
// edit" (opens that block's source to propose a change). The selection is
// resolved to a block from the DOM range's POSITION (not a content search),
// so a phrase repeated across or within blocks anchors where it was
// actually selected. Commented text is highlighted inline at its own
// occurrence (disambiguated by quote context), and open threads list in a
// side panel.
export function CommentsView({
  projectId,
  slug,
  markdown,
  docVersion,
  blocks,
  threads,
  names,
  onChange,
  onSuggest,
}: Readonly<{
  projectId: ProjectId;
  slug: string;
  markdown: string;
  docVersion: number;
  blocks: readonly BlockView[];
  threads: readonly CommentThreadView[];
  names: Readonly<Record<string, string>>;
  onChange: () => void;
  onSuggest: (proposedMarkdown: string) => Promise<string | undefined>;
}>): React.ReactElement {
  const hasPanel = threads.length > 0;
  return (
    <div className={hasPanel ? "flex gap-6" : undefined}>
      <div className="min-w-0 flex-1">
        <AnnotatableMarkdown
          projectId={projectId}
          slug={slug}
          markdown={markdown}
          docVersion={docVersion}
          blocks={blocks}
          threads={threads}
          onChange={onChange}
          onSuggest={onSuggest}
        />
      </div>
      {hasPanel && (
        <aside className="w-80 shrink-0 space-y-3">
          <div className="text-sm font-medium tracking-wide text-slate-500 uppercase">
            Comments
          </div>
          {threads.map((t) => (
            <ThreadCard
              key={t.id}
              projectId={projectId}
              thread={t}
              names={names}
              onChange={onChange}
            />
          ))}
        </aside>
      )}
    </div>
  );
}

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

function AnnotatableMarkdown({
  projectId,
  slug,
  markdown,
  docVersion,
  blocks,
  threads,
  onChange,
  onSuggest,
}: Readonly<{
  projectId: ProjectId;
  slug: string;
  markdown: string;
  docVersion: number;
  blocks: readonly BlockView[];
  threads: readonly CommentThreadView[];
  onChange: () => void;
  onSuggest: (proposedMarkdown: string) => Promise<string | undefined>;
}>): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const proseRef = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<Pending>();
  const [mode, setMode] = useState<Mode>("menu");
  const [body, setBody] = useState("");
  const [edited, setEdited] = useState("");

  // Highlight commented text inline at each open thread's anchored range.
  useEffect(() => {
    const prose = proseRef.current;
    if (prose === null) return undefined;
    applyHighlights(
      prose,
      threads
        .filter((t) => t.status === "open")
        .map((t) => ({
          blockId: t.anchorBlockId,
          start: t.anchorStart,
          end: t.anchorEnd,
          quote: t.quote,
        })),
      blocks,
    );
    return () => clearHighlights();
  }, [blocks, markdown, threads]);

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
          ? "The document changed — reload and try again."
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
    setPending(undefined);
    setMode("menu");
    setBody("");
    setEdited("");
    window.getSelection()?.removeAllRanges();
  }

  function onMouseUp(): void {
    if (mode !== "menu") return; // don't recapture mid-compose
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
    // Resolve the selection to a block + offset from its DOM position, so a
    // phrase that repeats elsewhere anchors where it was actually selected.
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

  return (
    <div ref={containerRef} className="relative" onMouseUp={onMouseUp}>
      <div ref={proseRef}>
        <Markdown source={markdown} />
      </div>
      {pending !== undefined && (
        <div
          className="absolute z-10"
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
                rows={3}
                placeholder="Add a comment…"
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
      // Keep the text selection alive through the click.
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

function ThreadCard({
  projectId,
  thread,
  names,
  onChange,
}: Readonly<{
  projectId: ProjectId;
  thread: CommentThreadView;
  names: Readonly<Record<string, string>>;
  onChange: () => void;
}>): React.ReactElement {
  const [reply, setReply] = useState("");
  const who = (id: string): string => names[id] ?? id;

  const { pending: replying, run: sendReply } = useSubmit(async () => {
    const text = reply.trim();
    if (text === "") return;
    await addComment({ data: { projectId, threadId: thread.id, body: text } });
    setReply("");
    onChange();
  });

  const { pending: resolving, run: resolve } = useSubmit(async () => {
    await resolveComment({ data: { projectId, threadId: thread.id } });
    onChange();
  });

  return (
    <Card className="space-y-2 px-4 py-3">
      <div className="flex items-center justify-between">
        <StatusBadge status={thread.status} />
        {thread.status === "open" && (
          <button
            type="button"
            disabled={resolving}
            onClick={() => void resolve()}
            className="text-sm font-medium text-slate-500 hover:text-green-700 disabled:opacity-50"
          >
            Resolve
          </button>
        )}
      </div>
      <blockquote className="line-clamp-2 border-l-2 border-slate-200 pl-2 text-sm text-slate-500">
        {thread.quote.exact}
      </blockquote>
      <ul className="space-y-1.5">
        {thread.comments.map((m) => (
          <li key={m.id} className="text-base [overflow-wrap:anywhere]">
            <span className="font-medium text-slate-900">
              {who(m.createdBy)}
            </span>{" "}
            <span className="text-slate-700">{m.body}</span>
          </li>
        ))}
      </ul>
      {thread.status === "open" && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void sendReply();
          }}
        >
          <input
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Reply…"
            className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          />
          <button
            type="submit"
            disabled={replying || reply.trim() === ""}
            className="text-sm font-medium text-blue-600 hover:text-blue-700 disabled:opacity-50"
          >
            Reply
          </button>
        </form>
      )}
    </Card>
  );
}

const STATUS_LABEL: Readonly<Record<CommentStatus, string>> = {
  open: "Open",
  resolved: "Resolved",
  orphaned: "Detached",
};
const STATUS_CLASS: Readonly<Record<CommentStatus, string>> = {
  open: "text-slate-500",
  resolved: "text-green-700",
  orphaned: "text-amber-700",
};

function StatusBadge({
  status,
}: Readonly<{ status: CommentStatus }>): React.ReactElement {
  return (
    <span className={cn("text-sm font-medium", STATUS_CLASS[status])}>
      {STATUS_LABEL[status]}
    </span>
  );
}
