import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { connectControlDb } from "@/control/db";
import { resolveAuthorLabels } from "@/control/users";
import { asDocumentSlug } from "@/ids";
import { projectMiddleware } from "@/lib/middleware";
import { changedBy, storeOf } from "@/lib/server/shared";
import { assertServerContext as srv } from "@/lib/server-context";
import type {
  ApplySuggestionResult,
  CreateSuggestionResult,
  SuggestionView,
} from "@/project-store/commands/suggestions";

export type {
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
      suggestions.map((s) => s.createdBy),
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
  .validator(z.object({ suggestionId: z.number().int() }))
  .handler(async ({ data, context }): Promise<ApplySuggestionResult> => {
    const c = srv(context);
    return storeOf(c).applySuggestion({
      suggestionId: data.suggestionId,
      appliedBy: changedBy(c),
    });
  });

export const rejectSuggestion = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(z.object({ suggestionId: z.number().int() }))
  .handler(async ({ data, context }): Promise<Readonly<{ ok: boolean }>> => {
    const c = srv(context);
    return storeOf(c).rejectSuggestion({
      suggestionId: data.suggestionId,
      rejectedBy: changedBy(c),
    });
  });
