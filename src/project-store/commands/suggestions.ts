import {
  applyHunks,
  CREATE_PROPOSAL_BASE_VERSION,
  diffSuggestion,
  type Hunk,
  type HunkOp,
  isCreateProposal,
  type ProposalOutcome,
  type SuggestionGranularity,
} from "@nicia-ai/prose-diff";

import type {
  HunkDecision,
  SuggestionHunkRow,
  SuggestionStatus,
} from "../../db";
import { ConflictError, ValidationError } from "../../errors";
import {
  asCorpusSlug,
  asDocumentSlug,
  asFolderSlug,
  type CallerChannel,
  type CorpusSlug,
  type DocumentSlug,
} from "../../ids";
import { DEFAULT_CORPUS_SLUG } from "../../store/domain/default-corpus";
import { resolveTitle } from "../../store/domain/frontmatter";
import {
  basename,
  defaultFilename,
  normalizeSlug,
  stripExtension,
} from "../../store/domain/paths";
import { markdownTooLarge } from "../../util";
import {
  type CommandOutcome,
  commandOutcome,
  type DomainChange,
  type ProjectCommandContext,
} from "../command";
import type { ProjectUnit } from "../unit";

import {
  corpusOfDocument,
  corpusTreeChanged,
  ensureCorpusRoot,
} from "./corpus-tree";
import { saveDocumentCommand } from "./documents";
import { ensureDefaultCorpusCommand } from "./ensure-default-corpus";
import { checkedPathSegments } from "./untrusted-path";

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
  // Whether this proposal reviews per-block or as one whole-document hunk
  // (the diff degraded) — see SUGGESTION_GRANULARITIES in the domain.
  granularity: SuggestionGranularity;
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

export type { ProposalOutcome } from "@nicia-ai/prose-diff";

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
  propStart: h.propStart,
  propEnd: h.propEnd,
  proposedText: h.proposedText,
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
  // Set by a corpus-scoped caller (MCP): the document must be in this
  // corpus at write time, or it is `missing` — indistinguishable from a
  // document that does not exist.
  inCorpus?: CorpusSlug | undefined;
}>;

export type CreateSuggestionResult = Readonly<
  | { ok: true; suggestionId: number; hunkCount: number }
  | { ok: false; reason: "missing" | "no-change" | "too-large" }
  | { ok: false; reason: "conflict"; currentVersion: number }
>;

// Diff the proposal against the CURRENT head and store the resulting hunks,
// each pending a reviewer decision. The proposal must target the live head
// (clientVersion guard → 409) so the stored base source ranges are valid.
export async function createSuggestionCommand(
  ctx: ProjectCommandContext,
  input: CreateSuggestionInput,
): Promise<CommandOutcome<CreateSuggestionResult>> {
  // The proposal body is stored verbatim and becomes the document on a
  // full-acceptance apply, so it is bound by the same byte cap as a save
  // (MAX_MARKDOWN_BYTES — the DO SQLite per-value limit rationale).
  if (markdownTooLarge(input.proposedMarkdown)) {
    return commandOutcome({ ok: false, reason: "too-large" });
  }
  const head = await ctx.u.docs.find(input.slug);
  if (head === undefined || head.archivedAt !== undefined) {
    return commandOutcome({ ok: false, reason: "missing" });
  }
  if (
    input.inCorpus !== undefined &&
    (await corpusOfDocument(ctx.u, input.slug)) !== input.inCorpus
  ) {
    return commandOutcome({ ok: false, reason: "missing" });
  }
  if (head.docVersion !== input.clientVersion) {
    throw new ConflictError(head.docVersion);
  }
  const base = (await ctx.u.blobs.get(head.contentHash)) ?? "";
  const { hunks, granularity } = diffSuggestion(base, input.proposedMarkdown);
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
    // Observability: whether the diff degraded to the whole-document hunk.
    granularity,
  });
  await ctx.u.suggestions.addHunks(
    hunks.map((h) => ({
      suggestionId,
      ordinal: h.ordinal,
      op: h.op,
      baseStart: h.baseStart,
      baseEnd: h.baseEnd,
      propStart: h.propStart,
      propEnd: h.propEnd,
      proposedText: h.proposedText,
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
  // The proposing connection's bound Corpus — where an applied
  // proposal's document is attached (as `reference`, never core).
  originCollectionSlug?: CorpusSlug;
}>;

export type CreateDocProposalResult = Readonly<
  | { ok: true; suggestionId: number; slug: string }
  // The slug (or the path's filename slot) already belongs to a live
  // document. Same existence grade the REST create path exposes via its
  // 403 — deliberate, so an agent can pick another identifier.
  | { ok: false; reason: "taken" }
  | { ok: false; reason: "invalid" }
  // The proposed body exceeds MAX_MARKDOWN_BYTES (see createSuggestion).
  | { ok: false; reason: "too-large" }
>;

// The MCP-facing subset of a create-proposal: identity + body only. The DO
// method injects createdBy/channel; the scoped executor pins
// `originCollectionSlug` to the caller's bound Corpus (never caller data —
// optional here only so the port and the DO method share one shape).
export type SuggestCreateInput = Readonly<{
  slug?: DocumentSlug;
  path?: string;
  proposedMarkdown: string;
  originCollectionSlug?: CorpusSlug;
}>;

export async function createDocProposalCommand(
  ctx: ProjectCommandContext,
  input: CreateDocProposalInput,
): Promise<CommandOutcome<CreateDocProposalResult>> {
  // Stored verbatim and materialized wholesale on apply — same byte cap
  // as createSuggestion / saveDocument.
  if (markdownTooLarge(input.proposedMarkdown)) {
    return commandOutcome({ ok: false, reason: "too-large" });
  }
  // An agent's path is untrusted: one that escapes the corpus is `invalid`.
  let segments: string[];
  try {
    segments = input.path === undefined ? [] : checkedPathSegments(input.path);
  } catch (error) {
    if (error instanceof ValidationError) {
      return commandOutcome({ ok: false, reason: "invalid" });
    }
    throw error;
  }
  const path = segments.length === 0 ? undefined : segments.join("/");
  if (input.slug === undefined && path === undefined) {
    return commandOutcome({ ok: false, reason: "invalid" });
  }
  // A proposal must be appliable when accepted: reject a path whose
  // slot is already occupied in the corpus it will be created in — by a
  // document OR a sibling folder of that name (the cross-type namespace
  // rule) — instead of filing a proposal that can only ever go stale at
  // apply. A missing folder chain means the slot is free.
  if (path !== undefined) {
    const rootSlug = await ctx.u.cols.rootFolderSlug(
      input.originCollectionSlug ?? DEFAULT_CORPUS_SLUG,
    );
    const dirFolder =
      rootSlug === undefined
        ? undefined
        : await ctx.u.folders.folderAt(rootSlug, segments.slice(0, -1));
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
    // Only a document in the corpus this proposal is for can conflict with
    // it. A slug that exists in another corpus or in drafts must not be
    // observable from here (an agent would learn it exists), so it is filed
    // like any other; a clash is settled by a person at apply time.
    if (
      (await ctx.u.docs.find(slug)) !== undefined &&
      (input.originCollectionSlug === undefined ||
        (await corpusOfDocument(ctx.u, slug)) === input.originCollectionSlug)
    ) {
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
  // The corpus the document will be created in when accepted, and its
  // path inside that corpus.
  corpusSlug: string;
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
    originCollectionSlug: string | null;
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
    corpusSlug: row.originCollectionSlug ?? DEFAULT_CORPUS_SLUG,
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
  // A corpus-scoped caller (MCP): the proposal must still belong to this
  // corpus when the reply is written — see `proposalInCorpus`.
  inCorpus?: CorpusSlug | undefined;
}>;

// Is this proposal, NOW, inside `corpusSlug`? An edit proposal follows its
// document (which may have been moved out since it was filed); a create
// proposal belongs to the corpus it was filed for. A scoped caller treats
// "no" exactly like "no such proposal".
export async function proposalInCorpus(
  u: ProjectUnit,
  proposal: Readonly<{
    documentSlug: string;
    originCollectionSlug: string | null;
    baseDocVersion: number;
  }>,
  corpusSlug: CorpusSlug,
): Promise<boolean> {
  return proposal.baseDocVersion === CREATE_PROPOSAL_BASE_VERSION
    ? proposal.originCollectionSlug === corpusSlug
    : (await corpusOfDocument(u, asDocumentSlug(proposal.documentSlug))) ===
        corpusSlug;
}

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
      proposal.createdBy !== input.expectedCreatedBy) ||
    (input.inCorpus !== undefined &&
      !(await proposalInCorpus(ctx.u, proposal, input.inCorpus)))
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

// Materialize an accepted create-proposal: the document is created in the
// proposing connection's bound Corpus, at the proposed corpus-relative
// path (missing folders are created, as an upload to the same path would),
// and the save carries `appliedFrom` provenance. A proposal with no origin
// — or whose corpus has since been deleted — lands in the default corpus:
// the document is still created, as a draft, never outside a corpus.
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

  const changes: DomainChange[] = [];
  const origin =
    s.originCollectionSlug === null
      ? undefined
      : asCorpusSlug(s.originCollectionSlug);
  let corpusSlug = origin ?? DEFAULT_CORPUS_SLUG;
  let rootSlug = await ensureCorpusRoot(ctx, corpusSlug);
  if (rootSlug === undefined) {
    corpusSlug = DEFAULT_CORPUS_SLUG;
    changes.push(
      ...(await ensureDefaultCorpusCommand(ctx, input.appliedBy)).changes,
    );
    rootSlug = await ensureCorpusRoot(ctx, corpusSlug);
  }
  if (rootSlug === undefined) {
    throw new Error("create-proposal apply: the default corpus has no root");
  }

  const segments =
    s.proposedPath === null ? [] : checkedPathSegments(s.proposedPath);
  const filename =
    segments.length === 0
      ? defaultFilename(slug)
      : basename(s.proposedPath ?? "");
  const ensured = await ctx.u.folders.ensureFolderPath(
    rootSlug,
    segments.slice(0, -1),
    ctx.now,
    (name, takenSlugs) => asFolderSlug(normalizeSlug(name, takenSlugs)),
  );
  if (!ensured.ok) return taken();
  if (await ctx.u.folders.slotOccupied(ensured.folderSlug, filename)) {
    // A document — or a folder claiming the name since the proposal was
    // filed — occupies the slot: mark stale before any write.
    return taken();
  }

  const saved = await saveDocumentCommand(ctx, {
    slug,
    markdown: s.proposedMarkdown,
    filename,
    folderSlug: ensured.folderSlug,
    clientVersion: 0,
    changedBy: input.appliedBy,
    appliedFrom: { suggestionId: s.id, by: s.createdBy, channel: s.channel },
  });
  changes.push(
    ...saved.changes,
    ...(await corpusTreeChanged(
      ctx,
      [corpusSlug],
      input.appliedBy,
      "membership",
    )),
  );
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
  // A partial acceptance splices accepted hunks into the base, and the
  // result can exceed MAX_MARKDOWN_BYTES even when the base and the
  // proposal are each under it. The DO maps the save-path sentinel to
  // this reason (full acceptance stores the already-capped proposal
  // verbatim, so it can never hit this).
  | { ok: false; reason: "too-large" }
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
  if (!allHunks.some((h) => h.decision === "accepted")) {
    return commandOutcome({ ok: false, reason: "nothing-accepted" });
  }
  // Rejected-revert: the new version is the stored proposal with every
  // non-accepted hunk (rejected or still pending) reverted to base bytes.
  // All-accepted is the degenerate case — zero reverts reproduce the
  // proposal verbatim by construction, no special case needed.
  const newMarkdown = applyHunks({
    base: (await ctx.u.blobs.get(head.contentHash)) ?? "",
    proposed: s.proposedMarkdown,
    rejected: allHunks.filter((h) => h.decision !== "accepted").map(toHunk),
  });
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
