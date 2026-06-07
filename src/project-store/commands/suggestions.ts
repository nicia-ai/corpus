import type {
  HunkDecision,
  SuggestionHunkRow,
  SuggestionStatus,
} from "../../db";
import { ConflictError } from "../../errors";
import { asDocumentSlug, type DocumentSlug } from "../../ids";
import {
  applyHunks,
  diffToHunks,
  type Hunk,
  type HunkOp,
} from "../../store/domain/suggestion";
import {
  type CommandOutcome,
  commandOutcome,
  type ProjectCommandContext,
} from "../command";

import { saveDocumentCommand } from "./documents";

export type { SuggestionStatus } from "../../db";

// — Read DTOs ————————————————————————————————————————————————————————

export type SuggestionHunkView = Readonly<{
  id: number;
  ordinal: number;
  op: HunkOp;
  baseStart: number;
  baseEnd: number;
  proposedText: string;
  decision: HunkDecision;
}>;

export type SuggestionView = Readonly<{
  id: number;
  status: SuggestionStatus;
  baseDocVersion: number;
  proposedMarkdown: string;
  createdBy: string;
  createdAt: string;
  hunks: readonly SuggestionHunkView[];
}>;

const toHunk = (h: SuggestionHunkRow): Hunk => ({
  ordinal: h.ordinal,
  op: h.op,
  baseStart: h.baseStart,
  baseEnd: h.baseEnd,
  proposedText: h.proposedText,
});

// — Create ———————————————————————————————————————————————————————————

export type CreateSuggestionInput = Readonly<{
  slug: DocumentSlug;
  proposedMarkdown: string;
  clientVersion: number;
  createdBy: string;
}>;

export type CreateSuggestionResult = Readonly<
  | { ok: true; suggestionId: number; hunkCount: number }
  | { ok: false; reason: "missing" | "no-change" }
  | { ok: false; reason: "conflict"; currentVersion: number }
>;

// Diff the proposal against the CURRENT head and store the resulting hunks,
// each pending a reviewer decision. The proposal must target the live head
// (clientVersion guard → 409) so the stored base source ranges are valid.
export async function createSuggestionCommand(
  ctx: ProjectCommandContext,
  input: CreateSuggestionInput,
): Promise<CommandOutcome<CreateSuggestionResult>> {
  const head = await ctx.u.docs.find(input.slug);
  if (head === undefined) {
    return commandOutcome({ ok: false, reason: "missing" });
  }
  if (head.docVersion !== input.clientVersion) {
    throw new ConflictError(head.docVersion);
  }
  const base = (await ctx.u.blobs.get(head.contentHash)) ?? "";
  const hunks = diffToHunks(base, input.proposedMarkdown);
  if (hunks.length === 0) {
    return commandOutcome({ ok: false, reason: "no-change" });
  }
  const suggestionId = await ctx.u.suggestions.create({
    documentSlug: input.slug,
    baseDocVersion: head.docVersion,
    proposedMarkdown: input.proposedMarkdown,
    status: "open",
    createdBy: input.createdBy,
    createdAt: ctx.now,
  });
  await ctx.u.suggestions.addHunks(
    hunks.map((h) => ({
      suggestionId,
      ordinal: h.ordinal,
      op: h.op,
      baseStart: h.baseStart,
      baseEnd: h.baseEnd,
      proposedText: h.proposedText,
      decision: "pending",
    })),
  );
  return commandOutcome({ ok: true, suggestionId, hunkCount: hunks.length });
}

// — Per-hunk decision ————————————————————————————————————————————————

export type SetHunkDecisionInput = Readonly<{
  hunkId: number;
  decision: "accepted" | "rejected";
}>;

// A hunk decision only counts while the parent suggestion is still open.
// Once applied / rejected / stale the suggestion is terminal; flipping a
// hunk after the fact would silently rewrite a settled review record.
export async function setHunkDecisionCommand(
  ctx: ProjectCommandContext,
  input: SetHunkDecisionInput,
): Promise<CommandOutcome<Readonly<{ ok: boolean }>>> {
  const hunk = await ctx.u.suggestions.getHunk(input.hunkId);
  if (hunk === undefined) return commandOutcome({ ok: false });
  const s = await ctx.u.suggestions.get(hunk.suggestionId);
  if (s?.status !== "open") return commandOutcome({ ok: false });
  await ctx.u.suggestions.setHunkDecision(input.hunkId, input.decision);
  return commandOutcome({ ok: true });
}

// — Apply / reject ———————————————————————————————————————————————————

export type ApplySuggestionInput = Readonly<{
  suggestionId: number;
  appliedBy: string;
}>;

export type ApplySuggestionResult = Readonly<
  | { ok: true; docVersion: number }
  | { ok: false; reason: "missing" | "not-open" | "nothing-accepted" }
  | { ok: false; reason: "stale"; currentVersion: number }
>;

// Materialize the accepted hunks into a new version via the normal save
// path (so comment anchors rebase too). Refuses if the head has moved off
// the suggestion's base — the stored source ranges would be wrong — and
// marks the suggestion stale.
export async function applySuggestionCommand(
  ctx: ProjectCommandContext,
  input: ApplySuggestionInput,
): Promise<CommandOutcome<ApplySuggestionResult>> {
  const s = await ctx.u.suggestions.get(input.suggestionId);
  if (s === undefined) return commandOutcome({ ok: false, reason: "missing" });
  if (s.status !== "open") {
    return commandOutcome({ ok: false, reason: "not-open" });
  }
  const slug = asDocumentSlug(s.documentSlug);
  const head = await ctx.u.docs.find(slug);
  if (head === undefined) {
    return commandOutcome({ ok: false, reason: "missing" });
  }
  if (head.docVersion !== s.baseDocVersion) {
    await ctx.u.suggestions.markStale(s.id);
    return commandOutcome({
      ok: false,
      reason: "stale",
      currentVersion: head.docVersion,
    });
  }
  const accepted = (await ctx.u.suggestions.hunksFor(s.id)).filter(
    (h) => h.decision === "accepted",
  );
  if (accepted.length === 0) {
    return commandOutcome({ ok: false, reason: "nothing-accepted" });
  }
  const base = (await ctx.u.blobs.get(head.contentHash)) ?? "";
  const newMarkdown = applyHunks(base, accepted.map(toHunk));
  const saved = await saveDocumentCommand(ctx, {
    slug,
    markdown: newMarkdown,
    clientVersion: head.docVersion,
    changedBy: input.appliedBy,
  });
  await ctx.u.suggestions.resolve(s.id, "applied", input.appliedBy, ctx.now);
  return {
    result: { ok: true, docVersion: saved.result.docVersion },
    changes: saved.changes,
  };
}

export type RejectSuggestionInput = Readonly<{
  suggestionId: number;
  rejectedBy: string;
}>;

// Reject is a terminal transition out of `open`; a suggestion already
// applied / rejected / stale stays put (no-op, ok:false) so a late reject
// can't clobber an applied suggestion's recorded outcome.
export async function rejectSuggestionCommand(
  ctx: ProjectCommandContext,
  input: RejectSuggestionInput,
): Promise<CommandOutcome<Readonly<{ ok: boolean }>>> {
  const s = await ctx.u.suggestions.get(input.suggestionId);
  if (s?.status !== "open") return commandOutcome({ ok: false });
  await ctx.u.suggestions.resolve(
    input.suggestionId,
    "rejected",
    input.rejectedBy,
    ctx.now,
  );
  return commandOutcome({ ok: true });
}
