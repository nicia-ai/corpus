import { lineDiff, type DiffLine } from "@nicia-ai/prose-diff";
import { Check, MessageSquare, PencilLine, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ProseDiff } from "@/components/diff/Diff";
import { Field } from "@/components/Field";
import { ProposalConversation } from "@/components/review/ProposalConversation";
import { Button } from "@/components/ui/Button";
import { cardClass } from "@/components/ui/Surface";
import type { CallerChannel, ProjectId } from "@/ids";
import { cn } from "@/lib/cn";
import { useSubmit } from "@/lib/forms";
import type { CommentAnchorEvidence, ReviewItem } from "@/lib/review-items";
import { placeReviewRailItems } from "@/lib/review-rail-layout";
import type { CommentStatus } from "@/lib/server/comments";
import { addComment, resolveComment } from "@/lib/server/comments";
import {
  applySuggestion,
  rejectSuggestion,
  setHunkDecision,
  type SuggestionHunkView,
  type SuggestionStatus,
} from "@/lib/server/suggestions";
import type { PresenceUser } from "@/lib/use-collab";

const REVIEW_CARD_CLASS = cardClass("space-y-3 px-4! py-3!");
const REVIEW_CARD_GAP = 12;

export type ReviewRailLayout = Readonly<{
  itemTops: Readonly<Record<string, number>>;
  documentHeight: number;
}>;

export function ReviewRail({
  projectId,
  items,
  commentNames,
  suggestionNames,
  baseMarkdown,
  presence,
  layout,
  applyDisabled = false,
  onChange,
}: Readonly<{
  projectId: ProjectId;
  items: readonly ReviewItem[];
  commentNames: Readonly<Record<string, string>>;
  suggestionNames: Readonly<Record<string, string>>;
  baseMarkdown: string;
  presence: readonly PresenceUser[];
  layout?: ReviewRailLayout;
  applyDisabled?: boolean;
  onChange: () => void;
}>): React.ReactElement {
  const positionedLayout =
    layout !== undefined && layout.documentHeight > 0 ? layout : undefined;

  return (
    <aside aria-label="Document review" className="space-y-3">
      {positionedLayout === undefined && (
        <>
          <PresenceRow users={presence} />
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-slate-500">Review</div>
            <span className="text-sm text-slate-500 tabular-nums">
              {items.length}
            </span>
          </div>
        </>
      )}
      <ReviewItems
        projectId={projectId}
        items={items}
        commentNames={commentNames}
        suggestionNames={suggestionNames}
        baseMarkdown={baseMarkdown}
        layout={positionedLayout}
        applyDisabled={applyDisabled}
        onChange={onChange}
      />
    </aside>
  );
}

function ReviewItems({
  projectId,
  items,
  commentNames,
  suggestionNames,
  baseMarkdown,
  layout,
  applyDisabled,
  onChange,
}: Readonly<{
  projectId: ProjectId;
  items: readonly ReviewItem[];
  commentNames: Readonly<Record<string, string>>;
  suggestionNames: Readonly<Record<string, string>>;
  baseMarkdown: string;
  layout: ReviewRailLayout | undefined;
  applyDisabled: boolean;
  onChange: () => void;
}>): React.ReactElement {
  const [itemHeights, setItemHeights] = useState<
    Readonly<Record<string, number>>
  >({});
  const updateItemHeight = useCallback((id: string, height: number): void => {
    setItemHeights((current) =>
      current[id] === height ? current : { ...current, [id]: height },
    );
  }, []);

  function renderItem(item: ReviewItem): React.ReactElement {
    return item.kind === "comment" ? (
      <CommentCard
        projectId={projectId}
        item={item}
        names={commentNames}
        onChange={onChange}
      />
    ) : (
      <SuggestionCard
        projectId={projectId}
        item={item}
        baseMarkdown={baseMarkdown}
        author={
          suggestionNames[item.suggestion.createdBy] ??
          item.suggestion.createdBy
        }
        names={suggestionNames}
        applyDisabled={applyDisabled}
        onChange={onChange}
      />
    );
  }

  if (layout === undefined) {
    return (
      <div className="space-y-3">
        {items.map((item) => (
          <div key={item.id}>{renderItem(item)}</div>
        ))}
      </div>
    );
  }

  const positionedItems: { item: ReviewItem; top: number }[] = [];
  const unpositionedItems: ReviewItem[] = [];
  for (const item of items) {
    const top = layout.itemTops[item.id];
    if (top === undefined) {
      unpositionedItems.push(item);
    } else {
      positionedItems.push({ item, top });
    }
  }

  const itemById = new Map<string, ReviewItem>(
    positionedItems.map(({ item }) => [item.id, item] as const),
  );
  const placements = placeReviewRailItems(
    positionedItems.map(({ item, top }) => ({
      id: item.id,
      anchorTop: top,
      height: itemHeights[item.id] ?? 0,
    })),
    REVIEW_CARD_GAP,
  );
  const positionedHeight = placements.at(-1)?.bottom ?? 0;

  return (
    <>
      <div
        className="relative"
        style={{ minHeight: Math.max(layout.documentHeight, positionedHeight) }}
      >
        {placements.map(({ id, top }) => {
          const item = itemById.get(id);
          if (item === undefined) return null;
          return (
            <MeasuredReviewItem
              key={id}
              id={id}
              top={top}
              onHeight={updateItemHeight}
            >
              {renderItem(item)}
            </MeasuredReviewItem>
          );
        })}
      </div>
      {unpositionedItems.length > 0 && (
        <div className="mt-3 space-y-3">
          {unpositionedItems.map((item) => (
            <div key={item.id}>{renderItem(item)}</div>
          ))}
        </div>
      )}
    </>
  );
}

function MeasuredReviewItem({
  id,
  top,
  onHeight,
  children,
}: Readonly<{
  id: string;
  top: number;
  onHeight: (id: string, height: number) => void;
  children: React.ReactNode;
}>): React.ReactElement {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = element.current;
    if (node === null) return;
    const report = (): void => {
      onHeight(id, Math.ceil(node.getBoundingClientRect().height));
    };
    report();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);
    observer.observe(node);
    return () => observer.disconnect();
  }, [id, onHeight]);

  return (
    <div ref={element} className="absolute right-0 left-0" style={{ top }}>
      {children}
    </div>
  );
}

function PresenceRow({
  users,
}: Readonly<{ users: readonly PresenceUser[] }>): React.ReactElement | null {
  if (users.length === 0) return null;
  const shown = users.slice(0, 5);
  const extra = users.length - shown.length;
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="text-sm font-medium text-slate-500">Viewing now</div>
      <div
        className="flex -space-x-1"
        aria-label={`Viewing now: ${users.map((u) => u.userName).join(", ")}`}
      >
        {shown.map((user) => (
          <span
            key={user.userId}
            title={user.userName}
            className="grid size-7 place-items-center rounded-full bg-slate-100 text-sm font-semibold text-slate-600 ring-2 ring-white"
          >
            {initials(user.userName)}
          </span>
        ))}
        {extra > 0 && (
          <span className="grid size-7 place-items-center rounded-full bg-slate-200 text-sm font-semibold text-slate-600 ring-2 ring-white">
            +{extra}
          </span>
        )}
      </div>
    </div>
  );
}

function CommentCard({
  projectId,
  item,
  names,
  onChange,
}: Readonly<{
  projectId: ProjectId;
  item: Extract<ReviewItem, { kind: "comment" }>;
  names: Readonly<Record<string, string>>;
  onChange: () => void;
}>): React.ReactElement {
  const [reply, setReply] = useState("");
  const [showAnchorChange, setShowAnchorChange] = useState(false);
  const thread = item.thread;
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
    <article className={REVIEW_CARD_CLASS}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-amber-700" />
          <StatusBadge status={thread.status} labels={COMMENT_STATUS_LABEL} />
        </div>
        {thread.status === "open" && (
          <button
            type="button"
            disabled={resolving}
            onClick={() => void resolve()}
            className="min-h-11 text-sm font-medium text-slate-500 hover:text-green-700 disabled:opacity-50"
          >
            Resolve
          </button>
        )}
      </div>
      <blockquote className="line-clamp-2 border-l-2 border-amber-200 pl-2 text-sm text-slate-500">
        {thread.quote.exact}
      </blockquote>
      {thread.status === "resolved" && (
        <ResolvedAnchorEvidence
          evidence={item.anchorEvidence}
          expanded={showAnchorChange}
          onExpandedChange={setShowAnchorChange}
        />
      )}
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
            placeholder="Reply..."
            className="min-h-11 min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          />
          <button
            type="submit"
            disabled={replying || reply.trim() === ""}
            className="min-h-11 text-sm font-medium text-blue-600 hover:text-blue-700 disabled:opacity-50"
          >
            Reply
          </button>
        </form>
      )}
    </article>
  );
}

function ResolvedAnchorEvidence({
  evidence,
  expanded,
  onExpandedChange,
}: Readonly<{
  evidence: CommentAnchorEvidence;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}>): React.ReactElement {
  const changed = evidence.status !== "present";
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span
          className={cn(
            "font-medium",
            changed ? "text-amber-700" : "text-slate-500",
          )}
        >
          {ANCHOR_EVIDENCE_LABEL[evidence.status]}
        </span>
        {changed && (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => onExpandedChange(!expanded)}
            className="min-h-11 font-medium text-slate-500 hover:text-slate-900"
          >
            {expanded ? "Hide change" : "Show change"}
          </button>
        )}
      </div>
      {changed && expanded && (
        <div className="rounded-md border border-slate-200 px-3 py-2">
          <ProseDiff lines={anchorEvidenceDiff(evidence)} />
        </div>
      )}
    </div>
  );
}

function SuggestionCard({
  projectId,
  item,
  baseMarkdown,
  author,
  names,
  applyDisabled,
  onChange,
}: Readonly<{
  projectId: ProjectId;
  item: Extract<ReviewItem, { kind: "suggestion" }>;
  baseMarkdown: string;
  author: string;
  names: Readonly<Record<string, string>>;
  applyDisabled: boolean;
  onChange: () => void;
}>): React.ReactElement {
  const suggestion = item.suggestion;
  const [reviewerNote, setReviewerNote] = useState("");
  const { run: decide } = useSubmit(
    async (hunkId: number, decision: "accepted" | "rejected") => {
      await setHunkDecision({ data: { projectId, hunkId, decision } });
      onChange();
    },
  );
  const {
    pending: applying,
    error: applyError,
    run: apply,
  } = useSubmit(async () => {
    const r = await applySuggestion({
      data: { projectId, suggestionId: suggestion.id, reviewerNote },
    });
    if (!r.ok) {
      throw new Error(applyErrorMessage(r.reason));
    }
    onChange();
  });
  const { run: reject } = useSubmit(async () => {
    await rejectSuggestion({
      data: { projectId, suggestionId: suggestion.id, reviewerNote },
    });
    onChange();
  });

  const acceptedCount = suggestion.hunks.filter(
    (h) => h.decision === "accepted",
  ).length;
  const open = suggestion.status === "open";

  return (
    <article data-proposal-id={suggestion.id} className={REVIEW_CARD_CLASS}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 text-base">
          <div className="flex min-w-0 items-center gap-2">
            <PencilLine className="h-4 w-4 shrink-0 text-green-700" />
            <span className="truncate font-medium text-slate-900">
              {author}
            </span>
            <ViaBadge channel={suggestion.channel} />
          </div>
          <div className="text-sm text-slate-500">
            {suggestion.granularity === "whole-document" ? (
              // The differ could not produce a faithful per-block split, so
              // the proposal collapsed to one hunk spanning the document.
              // Counting that as "1 change" reads like a one-line edit while
              // the reviewer is actually making an all-or-nothing call on the
              // whole file — say so (PRODUCT.md: make correctness legible).
              // Text, not a wash: the accessibility rule forbids hue alone,
              // and the whole body is already painted for this case.
              <>proposed a whole-document change — accept or reject as one</>
            ) : (
              <>
                proposed {suggestion.hunks.length} change
                {suggestion.hunks.length === 1 ? "" : "s"}
              </>
            )}
          </div>
        </div>
        <StatusBadge
          status={suggestion.status}
          labels={SUGGESTION_STATUS_LABEL}
        />
      </div>

      {suggestion.reviewerNote !== null && (
        <p className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">
          <span className="font-medium">Reviewer note:</span>{" "}
          {suggestion.reviewerNote}
        </p>
      )}

      {open && !item.applicable && (
        <p className="text-sm text-amber-700">
          Based on an earlier version. Recreate it against the current text.
        </p>
      )}

      <ProposalConversation
        projectId={projectId}
        proposalId={suggestion.id}
        messages={suggestion.messages.map((message) => ({
          id: message.id,
          body: message.body,
          authorLabel: names[message.createdBy] ?? message.createdBy,
          channel: message.channel,
          createdAt: message.createdAt,
        }))}
        canReply={open}
        onChange={onChange}
      />

      {open && item.applicable && (
        <>
          <ul className="max-h-96 space-y-3 overflow-auto pr-1">
            {suggestion.hunks.map((h) => (
              <li key={h.id} className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-slate-500">
                    {OP_LABEL[h.op]}
                  </span>
                  <div className="flex gap-1">
                    <DecisionButton
                      active={h.decision === "accepted"}
                      tone="accept"
                      onClick={() => void decide(h.id, "accepted")}
                    />
                    <DecisionButton
                      active={h.decision === "rejected"}
                      tone="reject"
                      onClick={() => void decide(h.id, "rejected")}
                    />
                  </div>
                </div>
                <div className="rounded-md border border-slate-200 px-3 py-2">
                  <ProseDiff
                    lines={lineDiff(hunkOld(h, baseMarkdown), hunkNew(h))}
                  />
                </div>
              </li>
            ))}
          </ul>
          <Field
            label="Reviewer note (optional)"
            as="textarea"
            rows={2}
            required={false}
            value={reviewerNote}
            onChange={setReviewerNote}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={applyDisabled || applying || acceptedCount === 0}
              onClick={() => void apply()}
            >
              Apply {acceptedCount} accepted
            </Button>
            <Button variant="secondary" onClick={() => void reject()}>
              Reject all
            </Button>
            {applyError !== undefined && (
              <span className="text-sm text-red-600">{applyError}</span>
            )}
            {applyDisabled && (
              <span className="text-sm text-slate-500">
                Save or discard your draft before applying.
              </span>
            )}
          </div>
        </>
      )}
    </article>
  );
}

const hunkOld = (h: SuggestionHunkView, base: string): string =>
  h.op === "insert" ? "" : base.slice(h.baseStart, h.baseEnd);
const hunkNew = (h: SuggestionHunkView): string =>
  h.op === "delete" ? "" : h.proposedText;

function anchorEvidenceDiff(
  evidence: CommentAnchorEvidence,
): readonly DiffLine[] {
  if (evidence.status === "present") return [];
  if (evidence.status === "removed") {
    return [{ tag: "removed", text: evidence.original }];
  }
  return [
    { tag: "removed", text: evidence.original },
    { tag: "added", text: evidence.current },
  ];
}

const OP_LABEL: Readonly<Record<SuggestionHunkView["op"], string>> = {
  replace: "Edit",
  insert: "Add",
  delete: "Remove",
};

const ANCHOR_EVIDENCE_LABEL: Readonly<
  Record<CommentAnchorEvidence["status"], string>
> = {
  present: "No change",
  changed: "Changed",
  removed: "Removed",
};

const COMMENT_STATUS_LABEL: Readonly<Record<CommentStatus, string>> = {
  open: "Open",
  resolved: "Resolved",
  orphaned: "Detached",
};

const SUGGESTION_STATUS_LABEL: Readonly<Record<SuggestionStatus, string>> = {
  open: "Open",
  applied: "Applied",
  rejected: "Rejected",
  stale: "Stale",
};

const VIA_LABEL: Partial<Record<CallerChannel, string>> = {
  mcp: "via MCP",
  cli: "via CLI",
};

// Exported for the proposed-documents review surface (DocumentsPage), so
// "via MCP"/"via CLI" reads identically wherever an agent proposal shows.
export function ViaBadge({
  channel,
}: Readonly<{ channel: CallerChannel }>): React.ReactElement | null {
  const label = VIA_LABEL[channel];
  if (label === undefined) return null;
  return (
    <span className="inline-flex shrink-0 items-center rounded-sm bg-slate-100 px-1.5 text-sm font-medium text-slate-600">
      {label}
    </span>
  );
}

function DecisionButton({
  active,
  tone,
  onClick,
}: Readonly<{
  active: boolean;
  tone: "accept" | "reject";
  onClick: () => void;
}>): React.ReactElement {
  const accept = tone === "accept";
  return (
    <button
      type="button"
      aria-label={accept ? "Accept hunk" : "Reject hunk"}
      onClick={onClick}
      className={cn(
        "inline-flex size-11 items-center justify-center rounded-sm border",
        active
          ? accept
            ? "border-green-300 bg-green-50 text-green-700"
            : "border-rose-300 bg-rose-50 text-rose-700"
          : "border-slate-200 text-slate-500 hover:bg-slate-50",
      )}
    >
      {accept ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
    </button>
  );
}

function StatusBadge<T extends string>({
  status,
  labels,
}: Readonly<{
  status: T;
  labels: Readonly<Record<T, string>>;
}>): React.ReactElement {
  return (
    <span className={cn("shrink-0 text-sm font-medium", statusClass(status))}>
      {labels[status]}
    </span>
  );
}

function statusClass(status: string): string {
  if (status === "applied" || status === "resolved") return "text-green-700";
  if (status === "rejected") return "text-slate-400";
  if (status === "stale" || status === "orphaned") return "text-amber-700";
  return "text-slate-500";
}

function initials(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return letters === "" ? "?" : letters;
}

function applyErrorMessage(reason: string): string {
  if (reason === "stale")
    return "The document changed; recreate this suggestion.";
  if (reason === "nothing-accepted") return "Accept at least one hunk first.";
  if (reason === "not-open") return "This suggestion is already settled.";
  if (reason === "too-large")
    return "Applying these hunks would put the document over the 1 MB markdown limit.";
  return "Could not apply this suggestion.";
}
