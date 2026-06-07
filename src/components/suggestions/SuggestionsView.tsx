import { ProseDiff } from "@/components/diff/Diff";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Surface";
import type { CallerChannel, ProjectId } from "@/ids";
import { cn } from "@/lib/cn";
import { lineDiff } from "@/lib/diff";
import { useSubmit } from "@/lib/forms";
import {
  applySuggestion,
  rejectSuggestion,
  setHunkDecision,
  type SuggestionHunkView,
  type SuggestionStatus,
  type SuggestionView,
} from "@/lib/server/suggestions";

// The review surface for proposed edits. Each suggestion lists its hunks as
// block-level diffs the reviewer accepts or rejects, then applies (accepted
// hunks become a new version) or rejects wholesale.
export function SuggestionsView({
  projectId,
  baseMarkdown,
  docVersion,
  suggestions,
  names,
  onReload,
  onApplied,
}: Readonly<{
  projectId: ProjectId;
  baseMarkdown: string;
  docVersion: number;
  suggestions: readonly SuggestionView[];
  names: Readonly<Record<string, string>>;
  onReload: () => void;
  onApplied: () => void;
}>): React.ReactElement {
  if (suggestions.length === 0) {
    return (
      <p className="text-base text-slate-500">
        No suggestions. Edit the document and choose “Suggest changes”.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {suggestions.map((s) => (
        <SuggestionCard
          key={s.id}
          projectId={projectId}
          suggestion={s}
          baseMarkdown={baseMarkdown}
          applicable={s.baseDocVersion === docVersion}
          author={names[s.createdBy] ?? s.createdBy}
          channel={s.channel}
          onReload={onReload}
          onApplied={onApplied}
        />
      ))}
    </div>
  );
}

const hunkOld = (h: SuggestionHunkView, base: string): string =>
  h.op === "insert" ? "" : base.slice(h.baseStart, h.baseEnd);
const hunkNew = (h: SuggestionHunkView): string =>
  h.op === "delete" ? "" : h.proposedText;
const OP_LABEL: Readonly<Record<SuggestionHunkView["op"], string>> = {
  replace: "Edit",
  insert: "Add",
  delete: "Remove",
};

// The "via" chip per transport. `web` is the unmarked default (a person in
// the browser); mcp/cli mark a non-browser author next to their name.
const VIA_LABEL: Partial<Record<CallerChannel, string>> = {
  mcp: "via MCP",
  cli: "via CLI",
};

function SuggestionCard({
  projectId,
  suggestion,
  baseMarkdown,
  applicable,
  author,
  channel,
  onReload,
  onApplied,
}: Readonly<{
  projectId: ProjectId;
  suggestion: SuggestionView;
  baseMarkdown: string;
  applicable: boolean;
  author: string;
  channel: CallerChannel;
  onReload: () => void;
  onApplied: () => void;
}>): React.ReactElement {
  const { run: decide } = useSubmit(
    async (hunkId: number, decision: "accepted" | "rejected") => {
      await setHunkDecision({ data: { projectId, hunkId, decision } });
      onReload();
    },
  );
  const {
    pending: applying,
    error: applyError,
    run: apply,
  } = useSubmit(async () => {
    const r = await applySuggestion({
      data: { projectId, suggestionId: suggestion.id },
    });
    if (r.ok) onApplied();
    onReload();
  });
  const { run: reject } = useSubmit(async () => {
    await rejectSuggestion({
      data: { projectId, suggestionId: suggestion.id },
    });
    onReload();
  });

  const open = suggestion.status === "open";
  const acceptedCount = suggestion.hunks.filter(
    (h) => h.decision === "accepted",
  ).length;

  return (
    <Card className="space-y-3 px-5 py-4">
      <div className="flex items-center justify-between">
        <div className="text-base">
          <span className="font-medium text-slate-900">{author}</span>
          {VIA_LABEL[channel] !== undefined && (
            <span className="ml-1.5 inline-flex items-center rounded-sm bg-slate-100 px-1.5 text-sm font-medium text-slate-600">
              {VIA_LABEL[channel]}
            </span>
          )}{" "}
          <span className="text-slate-500">
            proposed {suggestion.hunks.length} change
            {suggestion.hunks.length === 1 ? "" : "s"}
          </span>
        </div>
        <StatusBadge status={suggestion.status} />
      </div>

      {open && !applicable && (
        <p className="text-sm text-amber-700">
          Based on an earlier version of this document — recreate it to review
          against the current text.
        </p>
      )}

      {open && applicable && (
        <>
          <ul className="space-y-3">
            {suggestion.hunks.map((h) => (
              <li key={h.id} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-500">
                    {OP_LABEL[h.op]}
                  </span>
                  <div className="flex gap-1">
                    <DecisionButton
                      active={h.decision === "accepted"}
                      tone="accept"
                      onClick={() => void decide(h.id, "accepted")}
                    >
                      Accept
                    </DecisionButton>
                    <DecisionButton
                      active={h.decision === "rejected"}
                      tone="reject"
                      onClick={() => void decide(h.id, "rejected")}
                    >
                      Reject
                    </DecisionButton>
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
          <div className="flex items-center gap-3">
            <Button
              disabled={applying || acceptedCount === 0}
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
          </div>
        </>
      )}
    </Card>
  );
}

function DecisionButton({
  active,
  tone,
  onClick,
  children,
}: Readonly<{
  active: boolean;
  tone: "accept" | "reject";
  onClick: () => void;
  children: React.ReactNode;
}>): React.ReactElement {
  const activeClass =
    tone === "accept"
      ? "border-green-300 bg-green-50 text-green-700"
      : "border-amber-300 bg-amber-50 text-amber-700";
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-sm border px-2 py-0.5 text-sm font-medium",
        active
          ? activeClass
          : "border-slate-200 text-slate-500 hover:bg-slate-50",
      )}
    >
      {children}
    </button>
  );
}

const STATUS_LABEL: Readonly<Record<SuggestionStatus, string>> = {
  open: "Open",
  applied: "Applied",
  rejected: "Rejected",
  stale: "Stale",
};
const STATUS_CLASS: Readonly<Record<SuggestionStatus, string>> = {
  open: "text-slate-500",
  applied: "text-green-700",
  rejected: "text-slate-400",
  stale: "text-amber-700",
};

function StatusBadge({
  status,
}: Readonly<{ status: SuggestionStatus }>): React.ReactElement {
  return (
    <span className={cn("text-sm font-medium", STATUS_CLASS[status])}>
      {STATUS_LABEL[status]}
    </span>
  );
}
