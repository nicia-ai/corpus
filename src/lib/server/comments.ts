import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { connectControlDb } from "@/control/db";
import { resolveUserNames } from "@/control/users";
import { asDocumentSlug } from "@/ids";
import { projectMiddleware } from "@/lib/middleware";
import { changedBy, storeOf } from "@/lib/server/shared";
import { assertServerContext as srv } from "@/lib/server-context";
import type {
  CommentThreadView,
  CreateCommentResult,
  DocumentBlocksResult,
} from "@/project-store/commands/comments";

// Threads plus a userId → display-name map (names live in the control
// plane, the DO only stores ids), resolved once per list call.
export type CommentsResult = Readonly<{
  threads: readonly CommentThreadView[];
  names: Readonly<Record<string, string>>;
}>;

// Re-exported so the UI imports comment types from one place (the server
// boundary), the same way features import DocSnapshot from documents.ts.
export type {
  BlockView,
  CommentStatus,
  CommentThreadView,
  CommentView,
  CreateCommentResult,
  DocumentBlocksResult,
} from "@/project-store/commands/comments";

// The head version's blocks, addressed by index + source span, for
// rendering a document block-by-block in comment mode.
export const getDocumentBlocks = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .validator(z.object({ slug: z.string().min(1) }))
  .handler(async ({ data, context }): Promise<DocumentBlocksResult> => {
    const r = await storeOf(srv(context)).getDocumentBlocks(
      asDocumentSlug(data.slug),
    );
    return r.found
      ? { found: true, docVersion: r.docVersion, blocks: [...r.blocks] }
      : { found: false };
  });

export const listComments = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .validator(z.object({ slug: z.string().min(1) }))
  .handler(async ({ data, context }): Promise<CommentsResult> => {
    const c = srv(context);
    const threads = [
      ...(await storeOf(c).listComments(asDocumentSlug(data.slug))),
    ];
    const ids = new Set<string>();
    for (const t of threads) {
      ids.add(t.createdBy);
      for (const m of t.comments) ids.add(m.createdBy);
    }
    const names = await resolveUserNames(connectControlDb(c.env.DB), [...ids]);
    return { threads, names: Object.fromEntries(names) };
  });

export const createComment = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(
    z.object({
      slug: z.string().min(1),
      blockIndex: z.number().int().nonnegative(),
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
      body: z.string().min(1),
      clientVersion: z.number().int().nonnegative(),
    }),
  )
  .handler(async ({ data, context }): Promise<CreateCommentResult> => {
    const c = srv(context);
    return storeOf(c).createComment({
      slug: asDocumentSlug(data.slug),
      blockIndex: data.blockIndex,
      start: data.start,
      end: data.end,
      body: data.body,
      clientVersion: data.clientVersion,
      createdBy: changedBy(c),
    });
  });

export const addComment = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(z.object({ threadId: z.number().int(), body: z.string().min(1) }))
  .handler(
    async ({ data, context }): Promise<Readonly<{ commentId: number }>> => {
      const c = srv(context);
      return storeOf(c).addComment({
        threadId: data.threadId,
        body: data.body,
        createdBy: changedBy(c),
      });
    },
  );

export const resolveComment = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(z.object({ threadId: z.number().int() }))
  .handler(async ({ data, context }): Promise<Readonly<{ ok: true }>> => {
    const c = srv(context);
    return storeOf(c).resolveCommentThread({
      threadId: data.threadId,
      resolvedBy: changedBy(c),
    });
  });
