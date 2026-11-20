import type { ProposalResult } from "./project-store/commands/suggestions";

type FoundProposalResult = Extract<ProposalResult, { found: true }>;

// Where a person reviews a proposal: the document it edits, or the documents
// list for a new-document proposal (which has no page until it is applied).
// A settled create-proposal has nothing left to review, so no link.
export function proposalReviewUrl(
  location: Readonly<{ baseUrl: string; projectId: string }>,
  result: Pick<
    FoundProposalResult,
    "proposalId" | "kind" | "documentSlug" | "outcome"
  >,
): string | undefined {
  if (result.kind === "create" && result.outcome !== "open") {
    return undefined;
  }
  const projectId = encodeURIComponent(location.projectId);
  const reviewPath =
    result.kind === "create"
      ? `/p/${projectId}/documents`
      : `/p/${projectId}/documents/${encodeURIComponent(result.documentSlug)}`;
  const reviewUrl = new URL(reviewPath, `${location.baseUrl}/`);
  reviewUrl.hash = `proposal-${String(result.proposalId)}`;
  return reviewUrl.toString();
}
