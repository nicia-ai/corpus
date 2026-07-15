import { useRouter } from "@tanstack/react-router";
import { FilePlus2 } from "lucide-react";
import { useState } from "react";

import { Field } from "@/components/Field";
import { Markdown } from "@/components/markdown/Markdown";
import { ViaBadge } from "@/components/review/ReviewRail";
import { Button } from "@/components/ui/Button";
import { RelativeTime } from "@/components/ui/DateTime";
import { cardClass } from "@/components/ui/Surface";
import { showToast } from "@/components/ui/Toast";
import type { ProjectId } from "@/ids";
import { useSubmit } from "@/lib/forms";
import {
  applyCreateProposal,
  type ApplyCreateProposalResult,
  type CreateProposalItem,
  rejectSuggestion,
} from "@/lib/server/suggestions";

// Agent-proposed NEW documents, pending a human decision. Edit suggestions
// review inline on their document; a create-proposal has no document page
// yet, so it reviews here — the one place a curator already scans the
// project's documents. Apply creates the document (and attaches it to the
// proposing connection's Collection as reference); reject discards.

const APPLY_FAILURE: Readonly<Record<string, string>> = {
  taken:
    "That slug or path was taken since this was proposed — the proposal is now stale.",
  "not-open": "This proposal was already resolved.",
  "not-create": "This is not a new-document proposal.",
  missing: "This proposal no longer exists.",
};

function applyFailureMessage(
  r: Extract<ApplyCreateProposalResult, { ok: false }>,
): string {
  return APPLY_FAILURE[r.reason] ?? "Could not create the document.";
}

function ProposalCard({
  projectId,
  proposal,
}: Readonly<{
  projectId: ProjectId;
  proposal: CreateProposalItem;
}>): React.ReactElement {
  const router = useRouter();
  const [preview, setPreview] = useState(false);
  const [reviewerNote, setReviewerNote] = useState("");
  const {
    pending: applying,
    error: applyError,
    run: apply,
  } = useSubmit(async () => {
    const r = await applyCreateProposal({
      data: { projectId, suggestionId: proposal.id, reviewerNote },
    });
    if (!r.ok) throw new Error(applyFailureMessage(r));
    showToast(`Created “${proposal.title}”.`);
    await router.invalidate();
  });
  const {
    pending: rejecting,
    error: rejectError,
    run: reject,
  } = useSubmit(async () => {
    const r = await rejectSuggestion({
      data: { projectId, suggestionId: proposal.id, reviewerNote },
    });
    // A concurrent apply/reject already resolved it — refresh so the
    // card reflects reality instead of toasting a false success.
    if (!r.ok) {
      await router.invalidate();
      throw new Error("Proposal was already resolved.");
    }
    showToast("Proposal rejected.");
    await router.invalidate();
  });
  const acting = applying || rejecting;

  return (
    <article className={cardClass("space-y-3 px-4! py-3!")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <FilePlus2 aria-hidden className="h-4 w-4 shrink-0 text-green-700" />
        <span className="min-w-0 truncate font-medium text-slate-900">
          {proposal.title}
        </span>
        <span className="inline-flex shrink-0 items-center rounded-sm bg-green-100 px-1.5 text-sm font-medium text-green-800">
          Proposed
        </span>
        <span className="min-w-0 truncate font-mono text-sm text-slate-500">
          {proposal.path ?? `${proposal.slug}.md`}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
        <span className="font-medium text-slate-700">
          {proposal.authorLabel}
        </span>
        <ViaBadge channel={proposal.channel} />
        <RelativeTime iso={proposal.createdAt} />
      </div>
      {preview && (
        <div className="max-h-96 overflow-auto rounded-md border border-slate-200">
          <Markdown
            source={proposal.proposedMarkdown}
            bare
            bodyClassName="px-4"
          />
        </div>
      )}
      <Field
        label="Reviewer note (optional)"
        as="textarea"
        rows={2}
        required={false}
        value={reviewerNote}
        onChange={setReviewerNote}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={acting} onClick={() => void apply()}>
          Create document
        </Button>
        <Button
          variant="secondary"
          disabled={acting}
          onClick={() => void reject()}
        >
          Reject
        </Button>
        <Button variant="secondary" onClick={() => setPreview((p) => !p)}>
          {preview ? "Hide preview" : "Show preview"}
        </Button>
        {(applyError ?? rejectError) !== undefined && (
          <span className="text-sm text-red-600">
            {applyError ?? rejectError}
          </span>
        )}
      </div>
    </article>
  );
}

export function ProposedDocuments({
  projectId,
  proposals,
}: Readonly<{
  projectId: ProjectId;
  proposals: readonly CreateProposalItem[];
}>): React.ReactElement | null {
  if (proposals.length === 0) return null;
  return (
    <section aria-label="Proposed documents" className="space-y-3">
      <div>
        <h2 className="text-base font-semibold text-slate-900">
          Proposed documents
          <span className="ml-2 font-normal text-slate-500 tabular-nums">
            {proposals.length}
          </span>
        </h2>
        <p className="text-sm text-slate-500">
          An agent proposed these new documents. Creating one adds it to the
          project and to the collection the agent works from.
        </p>
      </div>
      <div className="space-y-3">
        {proposals.map((p) => (
          <ProposalCard key={p.id} projectId={projectId} proposal={p} />
        ))}
      </div>
    </section>
  );
}
