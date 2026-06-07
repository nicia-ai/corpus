import { and, eq, inArray } from "drizzle-orm";

import {
  comment,
  type CommentRow,
  commentThread,
  type CommentThreadRow,
  type LedgerDb,
  type NewComment,
  type NewCommentThread,
} from "../../db";

// Anchored comment threads + their messages, as a repository. Non-canonical
// human review layer (off-bundle, off-MCP). The status union and every row
// type are inferred from the schema, so an invalid status cannot be written
// or queried. All Drizzle noise lives here.
export class CommentRepo {
  constructor(private readonly db: LedgerDb) {}

  // Lazy-maintenance gate: does this document have any open thread to rebase?
  async hasOpenThreads(documentSlug: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: commentThread.id })
      .from(commentThread)
      .where(
        and(
          eq(commentThread.documentSlug, documentSlug),
          eq(commentThread.status, "open"),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  openThreads(documentSlug: string): Promise<readonly CommentThreadRow[]> {
    return this.db
      .select()
      .from(commentThread)
      .where(
        and(
          eq(commentThread.documentSlug, documentSlug),
          eq(commentThread.status, "open"),
        ),
      )
      .orderBy(commentThread.id);
  }

  threadsForDoc(documentSlug: string): Promise<readonly CommentThreadRow[]> {
    return this.db
      .select()
      .from(commentThread)
      .where(eq(commentThread.documentSlug, documentSlug))
      .orderBy(commentThread.id);
  }

  async createThread(row: NewCommentThread): Promise<number> {
    const [r] = await this.db
      .insert(commentThread)
      .values(row)
      .returning({ id: commentThread.id });
    return r?.id ?? 0;
  }

  async addComment(row: NewComment): Promise<number> {
    const [r] = await this.db
      .insert(comment)
      .values(row)
      .returning({ id: comment.id });
    return r?.id ?? 0;
  }

  commentsForThreads(
    threadIds: readonly number[],
  ): Promise<readonly CommentRow[]> {
    if (threadIds.length === 0) return Promise.resolve([]);
    return this.db
      .select()
      .from(comment)
      .where(inArray(comment.threadId, [...threadIds]))
      .orderBy(comment.id);
  }

  // After a rebase relocates a thread's anchor within the new document.
  async updateAnchor(
    threadId: number,
    anchor: Readonly<{ blockId: string; start: number; end: number }>,
  ): Promise<void> {
    await this.db
      .update(commentThread)
      .set({
        anchorBlockId: anchor.blockId,
        anchorStart: anchor.start,
        anchorEnd: anchor.end,
        status: "open",
      })
      .where(eq(commentThread.id, threadId));
  }

  async markOrphaned(threadId: number): Promise<void> {
    await this.db
      .update(commentThread)
      .set({ status: "orphaned" })
      .where(eq(commentThread.id, threadId));
  }

  async resolveThread(
    threadId: number,
    resolvedBy: string,
    resolvedAt: string,
  ): Promise<void> {
    await this.db
      .update(commentThread)
      .set({ status: "resolved", resolvedBy, resolvedAt })
      .where(eq(commentThread.id, threadId));
  }
}
