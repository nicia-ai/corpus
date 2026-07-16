import type {
  HunkDecision,
  SuggestionHunkRow,
  SuggestionStatus,
} from "../../db";
import { ConflictError } from "../../errors";
import {
  asCollectionSlug,
  asDocumentSlug,
  asFolderSlug,
  type CallerChannel,
  type CollectionSlug,
  type DocumentSlug,
} from "../../ids";
import { resolveTitle } from "../../store/domain/frontmatter";
import {
  basename,
  normalizeSlug,
  pathSegments,
  stripExtension,
} from "../../store/domain/paths";
import {
  applyHunks,
  CREATE_PROPOSAL_BASE_VERSION,
  diffToHunks,
  type Hunk,
  type HunkOp,
  isCreateProposal,
  type ProposalOutcome,
} from "../../store/domain/suggestion";
import {
  type CommandOutcome,
  commandOutcome,
  type ProjectCommandContext,
} from "../command";

import { attachDocumentsToCollectionCommand } from "./collections";
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

export type SuggestionMessageView = Readonly<{
  id: number;
  body: string;
  createdBy: string;
  channel: CallerChannel;
  createdAt: string;
}>;

export type SuggestionView = Readonly<{
  id: number;
  status: SuggestionStatus;
  baseDocVersion: number;
  proposedMarkdown: string;
  createdBy: string;
  // How the proposal arrived (web / mcp / cli) — drives the "via" label
  // next to the author, recorded truth rather than inferred from createdBy.
  channel: CallerChannel;
  createdAt: string;
  reviewerNote: string | null;
  hunks: readonly SuggestionHunkView[];
  messages: readonly SuggestionMessageView[];
}>;

export type ProposalMessage = Readonly<{
  id: number;
  body: string;
  role: "proposer" | "reviewer";
  channel: CallerChannel;
  createdAt: string;
}>;

export type { ProposalOutcome } from "../../store/domain/suggestion";

export type ProposalResult = Readonly<
  | { found: false }
  | {
      found: true;
      proposalId: number;
      kind: "edit" | "create";
      documentSlug: string;
      baseDocVersion: number;
      outcome: ProposalOutcome;
      resultingDocVersion?: number;
      reviewerNote?: string;
      resolvedAt?: string;
      acceptedHunks: readonly SuggestionHunkView[];
      messages: readonly ProposalMessage[];
    }
>;

const toHunk = (h: SuggestionHunkRow): Hunk => ({
  ordinal: h.ordinal,
  op: h.op,
  baseStart: h.baseStart,
  baseEnd: h.baseEnd,
  proposedText: h.proposedText,
  // Separator semantics live on the Hunk type (src/store/domain/suggestion.ts).
  leadSep: h.leadSep,
  trailSep: h.trailSep,
});

// — Create ———————————————————————————————————————————————————————————

export type CreateSuggestionInput = Readonly<{
  slug: DocumentSlug;
  proposedMarkdown: string;
  clientVersion: number;
  createdBy: string;
  // The transport the proposal came through. Optional here so direct/test
  // callers don't have to care; real paths set it (web fn → web, MCP → mcp).
  channel?: CallerChannel;
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
    // Authoritative default for an omitted channel (direct/test callers);
    // both real paths set it explicitly. The DB column's own `.default("web")`
    // exists only for the ADD COLUMN migration backfill, not as a second
    // runtime default.
    channel: input.channel ?? "web",
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
      leadSep: h.leadSep,
      trailSep: h.trailSep,
      decision: "pending",
    })),
  );
  return commandOutcome({ ok: true, suggestionId, hunkCount: hunks.length });
}

// — Create-proposals (agent proposes a NEW document) ————————————————
//
// A create-proposal reuses the suggestion table with `baseDocVersion: 0`
// as the discriminant — a real document's head is never below 1 (see
// nextVersion), so 0 can only mean "this document does not exist yet".
// No hunks: the whole body is the proposal, and the review decision is
// all-or-nothing (create it or don't).

export type CreateDocProposalInput = Readonly<{
  // Explicit slug, or omitted to derive one from `path` exactly the way
  // the import path does (normalizeSlug over the path segments).
  slug?: DocumentSlug;
  // Corpus path (`wiki/answer-x.md`) for folder placement on apply;
  // omitted = project root with the slug-derived filename.
  path?: string;
  proposedMarkdown: string;
  createdBy: string;
  channel?: CallerChannel;
  // The proposing connection's bound Collection — where an applied
  // proposal's document is attached (as `reference`, never core).
  originCollectionSlug?: CollectionSlug;
}>;

export type CreateDocProposalResult = Readonly<
  | { ok: true; suggestionId: number; slug: string }
  // The slug (or the path's filename slot) already belongs to a live
  // document. Same existence grade the REST create path exposes via its
  // 403 — deliberate, so an agent can pick another identifier.
  | { ok: false; reason: "taken" }
  | { ok: false; reason: "invalid" }
>;

// The MCP-facing subset of a create-proposal: identity + body only. The DO
// method injects createdBy/channel; the scoped executor pins
// `originCollectionSlug` to the caller's bound Collection (never caller data —
// optional here only so the port and the DO method share one shape).
export type SuggestCreateInput = Readonly<{
  slug?: DocumentSlug;
  path?: string;
  proposedMarkdown: string;
  originCollectionSlug?: CollectionSlug;
}>;

export async function createDocProposalCommand(
  ctx: ProjectCommandContext,
  input: CreateDocProposalInput,
): Promise<CommandOutcome<CreateDocProposalResult>> {
  const segments = input.path === undefined ? [] : pathSegments(input.path);
  const path = segments.length === 0 ? undefined : segments.join("/");
  if (input.slug === undefined && path === undefined) {
    return commandOutcome({ ok: false, reason: "invalid" });
  }
  // A proposal must be appliable when accepted: reject a path whose
  // slot is already occupied project-wide — by a document OR a sibling
  // folder of that name (the cross-type namespace rule) — instead of
  // filing a proposal that can only ever go stale at apply. A missing
  // folder chain means the slot is free.
  if (path !== undefined) {
    const dirFolder = await ctx.u.folders.folderAt(segments.slice(0, -1));
    if (
      dirFolder !== undefined &&
      (await ctx.u.folders.slotOccupied(dirFolder, basename(path)))
    ) {
      return commandOutcome({ ok: false, reason: "taken" });
    }
  }
  let slug: DocumentSlug;
  if (input.slug !== undefined) {
    slug = input.slug;
    if ((await ctx.u.docs.find(slug)) !== undefined) {
      return commandOutcome({ ok: false, reason: "taken" });
    }
  } else {
    // Derived slugs steer around every taken slug, so only an explicit
    // slug can collide.
    const taken = new Set((await ctx.u.docs.listAll()).map((d) => d.slug));
    slug = asDocumentSlug(normalizeSlug(path ?? "", taken));
  }
  const suggestionId = await ctx.u.suggestions.create({
    documentSlug: slug,
    baseDocVersion: CREATE_PROPOSAL_BASE_VERSION,
    proposedMarkdown: input.proposedMarkdown,
    status: "open",
    createdBy: input.createdBy,
    channel: input.channel ?? "web",
    createdAt: ctx.now,
    proposedPath: path ?? null,
    originCollectionSlug: input.originCollectionSlug ?? null,
  });
  return commandOutcome({ ok: true, suggestionId, slug });
}

// Read DTO for the review surface. Title inference mirrors the save path
// (frontmatter `title`, else first H1, else the filename/slug) so the
// proposal previews under the same name the created document will get.
export type CreateProposalView = Readonly<{
  id: number;
  slug: string;
  path: string | null;
  title: string;
  proposedMarkdown: string;
  createdBy: string;
  channel: CallerChannel;
  createdAt: string;
  messages: readonly SuggestionMessageView[];
}>;

export function createProposalView(
  row: Readonly<{
    id: number;
    documentSlug: string;
    proposedMarkdown: string;
    proposedPath: string | null;
    createdBy: string;
    channel: CallerChannel;
    createdAt: string;
  }>,
  messages: readonly SuggestionMessageView[] = [],
): CreateProposalView {
  const fallback =
    row.proposedPath === null
      ? row.documentSlug
      : stripExtension(basename(row.proposedPath));
  return {
    id: row.id,
    slug: row.documentSlug,
    path: row.proposedPath,
    title: resolveTitle({ markdown: row.proposedMarkdown, fallback }),
    proposedMarkdown: row.proposedMarkdown,
    createdBy: row.createdBy,
    channel: row.channel,
    createdAt: row.createdAt,
    messages,
  };
}

// — Proposal conversation ——————————————————————————————————————————

export type AddSuggestionMessageInput = Readonly<{
  suggestionId: number;
  body: string;
  createdBy: string;
  channel: CallerChannel;
  // MCP supplies this guard so ownership and the open-state check happen in
  // the same transaction as the insert. A guessed proposal id is indistinct
  // from a missing one and can never become a cross-caller write.
  expectedCreatedBy?: string;
}>;

export type AddSuggestionMessageResult = Readonly<
  | { ok: true; messageId: number; documentSlug: DocumentSlug }
  | { ok: false; reason: "missing" | "not-open" }
>;

export async function addSuggestionMessageCommand(
  ctx: ProjectCommandContext,
  input: AddSuggestionMessageInput,
): Promise<CommandOutcome<AddSuggestionMessageResult>> {
  const proposal = await ctx.u.suggestions.get(input.suggestionId);
  if (
    proposal === undefined ||
    (input.expectedCreatedBy !== undefined &&
      proposal.createdBy !== input.expectedCreatedBy)
  ) {
    return commandOutcome({ ok: false, reason: "missing" });
  }
  if (proposal.status !== "open") {
    return commandOutcome({ ok: false, reason: "not-open" });
  }
  const messageId = await ctx.u.suggestions.addMessage({
    suggestionId: proposal.id,
    body: input.body,
    createdBy: input.createdBy,
    channel: input.channel,
    createdAt: ctx.now,
  });
  return commandOutcome({
    ok: true,
    messageId,
    documentSlug: asDocumentSlug(proposal.documentSlug),
  });
}

export type ApplyCreateProposalInput = Readonly<{
  suggestionId: number;
  appliedBy: string;
  reviewerNote?: string;
}>;

export type ApplyCreateProposalResult = Readonly<
  | { ok: true; docVersion: number; documentSlug: DocumentSlug }
  | { ok: false; reason: "missing" | "not-open" | "not-create" }
  // The slug or the target path slot was taken since the proposal was
  // filed; the proposal is marked stale (mirrors the edit-apply UX).
  | { ok: false; reason: "taken" }
>;

// Materialize an accepted create-proposal: folder placement + document
// creation follow importDocumentAtPathCommand's semantics (missing
// folders are created, matching what the REST/CLI import does for the
// same path), the save carries `appliedFrom` provenance, and the created
// document is attached to the proposing connection's bound Collection as
// `reference` — never the always-include tier, which stays a curator
// decision.
export async function applyCreateProposalCommand(
  ctx: ProjectCommandContext,
  input: ApplyCreateProposalInput,
): Promise<CommandOutcome<ApplyCreateProposalResult>> {
  const s = await ctx.u.suggestions.get(input.suggestionId);
  if (s === undefined) return commandOutcome({ ok: false, reason: "missing" });
  if (s.status !== "open") {
    return commandOutcome({ ok: false, reason: "not-open" });
  }
  if (!isCreateProposal(s)) {
    return commandOutcome({ ok: false, reason: "not-create" });
  }
  const slug = asDocumentSlug(s.documentSlug);
  const taken = async (): Promise<
    CommandOutcome<ApplyCreateProposalResult>
  > => {
    await ctx.u.suggestions.markStale(s.id);
    return commandOutcome<ApplyCreateProposalResult>({
      ok: false,
      reason: "taken",
    });
  };
  if ((await ctx.u.docs.find(slug)) !== undefined) return taken();

  const segments = s.proposedPath === null ? [] : pathSegments(s.proposedPath);
  const filename =
    segments.length === 0 ? undefined : basename(s.proposedPath ?? "");
  const ensured = await ctx.u.folders.ensureFolderPath(
    segments.slice(0, -1),
    ctx.now,
    (name, takenSlugs) => asFolderSlug(normalizeSlug(name, takenSlugs)),
  );
  if (!ensured.ok) return taken();
  if (
    filename !== undefined &&
    (await ctx.u.folders.slotOccupied(ensured.folderSlug, filename))
  ) {
    // A document — or a folder claiming the name since the proposal was
    // filed — occupies the slot: mark stale before any write.
    return taken();
  }

  const saved = await saveDocumentCommand(ctx, {
    slug,
    markdown: s.proposedMarkdown,
    ...(filename !== undefined ? { filename } : {}),
    // Scope the save path's own filename-collision check to the folder
    // this document is about to be placed in — a root document sharing
    // the filename is not a collision (paths.ts: per-folder namespace).
    folderSlug: ensured.folderSlug,
    clientVersion: 0,
    changedBy: input.appliedBy,
    appliedFrom: { suggestionId: s.id, by: s.createdBy, channel: s.channel },
  });
  const changes = [...saved.changes];
  if (ensured.folderSlug !== null) {
    const placed = await ctx.u.folders.placeDocument(slug, ensured.folderSlug);
    // The slot pre-check above covers every known collision, so a
    // placement failure here is a bug — throw so the whole transaction
    // (document, version, blob, events) rolls back, never committing an
    // unplaced orphan behind a soft "taken" result.
    if (!placed.ok) {
      throw new Error(
        `create-proposal apply: placement failed (${placed.reason})`,
      );
    }
  }
  if (s.originCollectionSlug !== null) {
    // The proposing connection's Collection may have been deleted since; a
    // vanished collection makes the attach a no-op (attachMany returns
    // nothing), so the document is still created — only the attach is
    // skipped. attachDocumentsToCollectionCommand computes the end position
    // itself, so we don't project the members just to count them.
    const attached = await attachDocumentsToCollectionCommand(ctx, {
      collectionSlug: asCollectionSlug(s.originCollectionSlug),
      documentSlugs: [slug],
      delivery: "reference",
      changedBy: input.appliedBy,
    });
    changes.push(...attached.changes);
  }
  // saveDocumentCommand staled every open proposal for this slug
  // (including this one); resolve() then records THIS one's true outcome.
  await ctx.u.suggestions.resolve({
    id: s.id,
    status: "applied",
    resolvedBy: input.appliedBy,
    resolvedAt: ctx.now,
    resultDocVersion: saved.result.docVersion,
    ...(input.reviewerNote === undefined
      ? {}
      : { reviewerNote: input.reviewerNote }),
  });
  return {
    result: {
      ok: true,
      docVersion: saved.result.docVersion,
      documentSlug: slug,
    },
    changes,
  };
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
  reviewerNote?: string;
}>;

export type ApplySuggestionResult = Readonly<
  | { ok: true; docVersion: number }
  | { ok: false; reason: "missing" | "not-open" | "nothing-accepted" }
  | { ok: false; reason: "stale"; currentVersion: number }
>;

type ApplySuggestionCommandResult = Readonly<
  | { ok: true; docVersion: number; documentSlug: DocumentSlug }
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
): Promise<CommandOutcome<ApplySuggestionCommandResult>> {
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
  const allHunks = await ctx.u.suggestions.hunksFor(s.id);
  const accepted = allHunks.filter((h) => h.decision === "accepted");
  if (accepted.length === 0) {
    return commandOutcome({ ok: false, reason: "nothing-accepted" });
  }
  // Every hunk accepted ⇒ the new version is the stored proposal VERBATIM.
  // For rows created since diffToHunks became self-verifying the splice
  // would produce the same bytes; this branch exists for LEGACY rows (empty
  // separator columns, pre-0007) whose splice re-synthesizes joins — and it
  // skips the base blob read on the most common apply outcome.
  const newMarkdown =
    accepted.length === allHunks.length
      ? s.proposedMarkdown
      : applyHunks(
          (await ctx.u.blobs.get(head.contentHash)) ?? "",
          accepted.map(toHunk),
        );
  const saved = await saveDocumentCommand(ctx, {
    slug,
    markdown: newMarkdown,
    clientVersion: head.docVersion,
    changedBy: input.appliedBy,
    // Durable origin: the human approver is `changedBy`; this links the new
    // version back to the suggestion (and the agent/human that proposed it).
    appliedFrom: { suggestionId: s.id, by: s.createdBy, channel: s.channel },
  });
  await ctx.u.suggestions.resolve({
    id: s.id,
    status: "applied",
    resolvedBy: input.appliedBy,
    resolvedAt: ctx.now,
    resultDocVersion: saved.result.docVersion,
    ...(input.reviewerNote === undefined
      ? {}
      : { reviewerNote: input.reviewerNote }),
  });
  // The head just advanced, so every other open suggestion on this doc is now
  // off-base — mark them stale eagerly instead of leaving them "open" until
  // someone next tries to apply them (which is when the UI would otherwise
  // show an "Open" badge alongside an "earlier version" warning).
  await ctx.u.suggestions.staleOpenForDoc(s.documentSlug);
  return {
    result: {
      ok: true,
      docVersion: saved.result.docVersion,
      documentSlug: slug,
    },
    changes: saved.changes,
  };
}

export type RejectSuggestionInput = Readonly<{
  suggestionId: number;
  rejectedBy: string;
  reviewerNote?: string;
}>;

// Reject is a terminal transition out of `open`; a suggestion already
// applied / rejected / stale stays put (no-op, ok:false) so a late reject
// can't clobber an applied suggestion's recorded outcome.
export async function rejectSuggestionCommand(
  ctx: ProjectCommandContext,
  input: RejectSuggestionInput,
): Promise<
  CommandOutcome<Readonly<{ ok: boolean; documentSlug?: DocumentSlug }>>
> {
  const s = await ctx.u.suggestions.get(input.suggestionId);
  if (s?.status !== "open") return commandOutcome({ ok: false });
  await ctx.u.suggestions.resolve({
    id: input.suggestionId,
    status: "rejected",
    resolvedBy: input.rejectedBy,
    resolvedAt: ctx.now,
    ...(input.reviewerNote === undefined
      ? {}
      : { reviewerNote: input.reviewerNote }),
  });
  return commandOutcome({
    ok: true,
    documentSlug: asDocumentSlug(s.documentSlug),
  });
}
