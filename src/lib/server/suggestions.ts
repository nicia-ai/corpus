import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { connectControlDb } from "@/control/db";
import { entitlementsOf } from "@/control/entitlements";
import { resolveAuthorLabels } from "@/control/users";
import { asDocumentSlug } from "@/ids";
import type { CallerChannel } from "@/ids";
import { projectMiddleware } from "@/lib/middleware";
import { proposalMessageSchema } from "@/lib/proposal-message";
import { reviewerNoteSchema } from "@/lib/reviewer-note";
import { changedBy, storeOf } from "@/lib/server/shared";
import { assertServerContext as srv } from "@/lib/server-context";
import type {
  ApplyCreateProposalResult,
  ApplySuggestionResult,
  AddSuggestionMessageResult,
  CreateSuggestionResult,
  SuggestionView,
} from "@/project-store/commands/suggestions";
import { compact, utf8Bytes } from "@/util";

const ReviewDecisionInput = z.object({
  suggestionId: z.number().int(),
  reviewerNote: reviewerNoteSchema.optional(),
});

export type {
  ApplyCreateProposalResult,
  ApplySuggestionResult,
  CreateSuggestionResult,
  SuggestionHunkView,
  SuggestionStatus,
  SuggestionView,
} from "@/project-store/commands/suggestions";

// Suggestions plus a userId → display-name map (the DO stores only ids).
export type SuggestionsResult = Readonly<{
  suggestions: readonly SuggestionView[];
  names: Readonly<Record<string, string>>;
}>;

export const listSuggestions = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .validator(z.object({ slug: z.string().min(1) }))
  .handler(async ({ data, context }): Promise<SuggestionsResult> => {
    const c = srv(context);
    const suggestions = [
      ...(await storeOf(c).listSuggestions(asDocumentSlug(data.slug))),
    ];
    const names = await resolveAuthorLabels(
      connectControlDb(c.env.DB),
      suggestions.flatMap((s) => [
        s.createdBy,
        ...s.messages.map((message) => message.createdBy),
      ]),
    );
    return { suggestions, names: Object.fromEntries(names) };
  });

export const createSuggestion = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(
    z.object({
      slug: z.string().min(1),
      proposedMarkdown: z.string(),
      clientVersion: z.number().int().nonnegative(),
    }),
  )
  .handler(async ({ data, context }): Promise<CreateSuggestionResult> => {
    const c = srv(context);
    return storeOf(c).createSuggestion({
      slug: asDocumentSlug(data.slug),
      proposedMarkdown: data.proposedMarkdown,
      clientVersion: data.clientVersion,
      createdBy: changedBy(c),
      channel: "web",
    });
  });

export const setHunkDecision = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(
    z.object({
      hunkId: z.number().int(),
      decision: z.enum(["accepted", "rejected"]),
    }),
  )
  .handler(async ({ data, context }): Promise<Readonly<{ ok: boolean }>> => {
    return storeOf(srv(context)).setHunkDecision({
      hunkId: data.hunkId,
      decision: data.decision,
    });
  });

export const applySuggestion = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(ReviewDecisionInput)
  .handler(async ({ data, context }): Promise<ApplySuggestionResult> => {
    const c = srv(context);
    return storeOf(c).applySuggestion(
      compact({
        suggestionId: data.suggestionId,
        appliedBy: changedBy(c),
        reviewerNote: data.reviewerNote,
      }),
    );
  });

// A pending agent-proposed NEW document, with the author resolved to a
// display label (the DO stores only caller refs). Plain DTO — the DO view
// carries branded-adjacent shapes that must not cross the server-fn
// serialization boundary.
export type CreateProposalItem = Readonly<{
  id: number;
  slug: string;
  path: string | null;
  title: string;
  proposedMarkdown: string;
  authorLabel: string;
  channel: CallerChannel;
  createdAt: string;
  messages: readonly Readonly<{
    id: number;
    body: string;
    authorLabel: string;
    channel: CallerChannel;
    createdAt: string;
  }>[];
}>;

export const listCreateProposals = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .handler(async ({ context }): Promise<readonly CreateProposalItem[]> => {
    const c = srv(context);
    const proposals = await storeOf(c).listCreateProposals();
    const names = await resolveAuthorLabels(
      connectControlDb(c.env.DB),
      proposals.flatMap((proposal) => [
        proposal.createdBy,
        ...proposal.messages.map((message) => message.createdBy),
      ]),
    );
    return proposals.map((p) => ({
      id: p.id,
      slug: p.slug,
      path: p.path,
      title: p.title,
      proposedMarkdown: p.proposedMarkdown,
      authorLabel: names.get(p.createdBy) ?? p.createdBy,
      channel: p.channel,
      createdAt: p.createdAt,
      messages: p.messages.map((message) => ({
        id: message.id,
        body: message.body,
        authorLabel: names.get(message.createdBy) ?? message.createdBy,
        channel: message.channel,
        createdAt: message.createdAt,
      })),
    }));
  });

export const addProposalMessage = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(
    z.object({
      suggestionId: z.number().int().positive(),
      body: proposalMessageSchema,
    }),
  )
  .handler(
    async ({
      data,
      context,
    }): Promise<
      Readonly<
        | { ok: true; messageId: number }
        | { ok: false; reason: "missing" | "not-open" }
      >
    > => {
      const c = srv(context);
      const result: AddSuggestionMessageResult = await storeOf(
        c,
      ).addSuggestionMessage({
        suggestionId: data.suggestionId,
        body: data.body,
        createdBy: changedBy(c),
        channel: "web",
      });
      return result.ok ? { ok: true, messageId: result.messageId } : result;
    },
  );

export const applyCreateProposal = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(ReviewDecisionInput)
  .handler(async ({ data, context }): Promise<ApplyCreateProposalResult> => {
    const c = srv(context);
    // Apply CREATES canonical markdown, so it owes the same quota check
    // as the direct create path (documents.ts saveDocument). The open
    // proposal supplies the byte count; a proposal that is no longer
    // open creates nothing, so the DO's own not-open result suffices.
    const proposal = (await storeOf(c).listCreateProposals()).find(
      (candidate) => candidate.id === data.suggestionId,
    );
    if (proposal !== undefined) {
      await entitlementsOf(c).assertWithinQuota({
        action: "document_create",
        userId: c.project?.userId,
        organizationId: c.project?.organizationId,
        projectId: c.project?.projectId,
        amount: 1,
        bytes: utf8Bytes(proposal.proposedMarkdown),
      });
    }
    return storeOf(c).applyCreateProposal(
      compact({
        suggestionId: data.suggestionId,
        appliedBy: changedBy(c),
        reviewerNote: data.reviewerNote,
      }),
    );
  });

export const rejectSuggestion = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(ReviewDecisionInput)
  .handler(async ({ data, context }): Promise<Readonly<{ ok: boolean }>> => {
    const c = srv(context);
    return storeOf(c).rejectSuggestion(
      compact({
        suggestionId: data.suggestionId,
        rejectedBy: changedBy(c),
        reviewerNote: data.reviewerNote,
      }),
    );
  });
