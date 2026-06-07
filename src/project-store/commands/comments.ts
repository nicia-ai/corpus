import type { CommentStatus } from "../../db";
import { ConflictError } from "../../errors";
import type { DocumentSlug } from "../../ids";
import { resolveAnchor } from "../../store/domain/anchor";
import type { BlockKind } from "../../store/domain/block-match";
import {
  type CommandOutcome,
  commandOutcome,
  type ProjectCommandContext,
} from "../command";

import { ensureHeadBlockMap } from "./anchoring";

export type { CommentStatus } from "../../db";

// — Read DTOs (block views + thread views) ——————————————————————————

// A block as the client sees it for selecting a comment target. Addressed
// by `index` within the version; the server resolves index → stable block
// id when the comment is created.
export type BlockView = Readonly<{
  id?: string;
  index: number;
  kind: BlockKind;
  text: string;
  // Half-open span in the document's source markdown, so the client can
  // render the block from its own slice.
  sourceStart: number;
  sourceEnd: number;
}>;

export type DocumentBlocksResult = Readonly<
  | { found: false }
  | { found: true; docVersion: number; blocks: readonly BlockView[] }
>;

export type CommentView = Readonly<{
  id: number;
  body: string;
  createdBy: string;
  createdAt: string;
}>;

export type CommentThreadView = Readonly<{
  id: number;
  status: CommentStatus;
  anchorBlockId: string;
  anchorStart: number;
  anchorEnd: number;
  quote: Readonly<{ prefix: string; exact: string; suffix: string }>;
  createdBy: string;
  createdAt: string;
  resolvedBy: string | undefined;
  resolvedAt: string | undefined;
  comments: readonly CommentView[];
}>;

// — Write commands ——————————————————————————————————————————————————

export type CreateCommentInput = Readonly<{
  slug: DocumentSlug;
  blockIndex: number;
  start: number;
  end: number;
  body: string;
  clientVersion: number;
  createdBy: string;
}>;

export type CreateCommentResult = Readonly<
  | { ok: true; threadId: number; commentId: number }
  | { ok: false; reason: "missing" | "bad-block" }
  // Mapped from ConflictError at the DO boundary when the head moved under
  // the selection (the command itself throws, like saveDocument's 409).
  | { ok: false; reason: "conflict"; currentVersion: number }
>;

// Anchors a new thread to a block of the head version. `clientVersion`
// guards against the head moving under the selection (→ ConflictError, a
// 409 at the DO boundary). The quote is derived server-side from the block
// text, so the client only sends a block index + intra-block range.
export async function createCommentCommand(
  ctx: ProjectCommandContext,
  input: CreateCommentInput,
): Promise<CommandOutcome<CreateCommentResult>> {
  const head = await ctx.u.docs.find(input.slug);
  if (head === undefined) {
    return commandOutcome({ ok: false, reason: "missing" });
  }
  if (head.docVersion !== input.clientVersion) {
    throw new ConflictError(head.docVersion);
  }
  const blocks = await ensureHeadBlockMap(ctx, input.slug, head);
  const target = blocks[input.blockIndex];
  if (target === undefined) {
    return commandOutcome({ ok: false, reason: "bad-block" });
  }
  const anchor = resolveAnchor(target, input.start, input.end);
  const threadId = await ctx.u.comments.createThread({
    documentSlug: input.slug,
    anchorBlockId: anchor.blockId,
    anchorStart: anchor.start,
    anchorEnd: anchor.end,
    quotePrefix: anchor.quote.prefix,
    quoteExact: anchor.quote.exact,
    quoteSuffix: anchor.quote.suffix,
    status: "open",
    createdBy: input.createdBy,
    createdAt: ctx.now,
  });
  const commentId = await ctx.u.comments.addComment({
    threadId,
    body: input.body,
    createdBy: input.createdBy,
    createdAt: ctx.now,
  });
  return commandOutcome({ ok: true, threadId, commentId });
}

export type AddCommentInput = Readonly<{
  threadId: number;
  body: string;
  createdBy: string;
}>;

export async function addCommentCommand(
  ctx: ProjectCommandContext,
  input: AddCommentInput,
): Promise<CommandOutcome<Readonly<{ commentId: number }>>> {
  const commentId = await ctx.u.comments.addComment({
    threadId: input.threadId,
    body: input.body,
    createdBy: input.createdBy,
    createdAt: ctx.now,
  });
  return commandOutcome({ commentId });
}

export type ResolveThreadInput = Readonly<{
  threadId: number;
  resolvedBy: string;
}>;

export async function resolveThreadCommand(
  ctx: ProjectCommandContext,
  input: ResolveThreadInput,
): Promise<CommandOutcome<Readonly<{ ok: true }>>> {
  await ctx.u.comments.resolveThread(input.threadId, input.resolvedBy, ctx.now);
  return commandOutcome({ ok: true });
}
