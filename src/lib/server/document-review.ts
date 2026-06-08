import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { connectControlDb } from "@/control/db";
import { resolveAuthorLabels, resolveUserNames } from "@/control/users";
import { asDocumentSlug } from "@/ids";
import { projectMiddleware } from "@/lib/middleware";
import type {
  CommentsResult,
  DocumentBlocksResult,
} from "@/lib/server/comments";
import type { DocSnapshot, DocVersionEntry } from "@/lib/server/documents";
import { storeOf } from "@/lib/server/shared";
import type { SuggestionsResult } from "@/lib/server/suggestions";
import { assertServerContext as srv } from "@/lib/server-context";
import { compact } from "@/util";

export type DocumentReviewResult = Readonly<{
  doc: DocSnapshot | undefined;
  blocks: DocumentBlocksResult;
  comments: CommentsResult;
  suggestions: SuggestionsResult;
}>;

export type DocumentHistoryResult = Readonly<{
  doc: DocSnapshot | undefined;
  history: readonly DocVersionEntry[];
}>;

function docSnapshot(
  doc: Readonly<{
    slug: string;
    title: string;
    filename: string;
    markdown: string;
    docVersion: number;
    updatedAt: string;
  }>,
): DocSnapshot {
  return {
    slug: asDocumentSlug(doc.slug),
    title: doc.title,
    filename: doc.filename,
    markdown: doc.markdown,
    docVersion: doc.docVersion,
    updatedAt: doc.updatedAt,
  };
}

export const getDocumentReview = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .validator(z.object({ slug: z.string().min(1) }))
  .handler(async ({ data, context }): Promise<DocumentReviewResult> => {
    const c = srv(context);
    const snapshot = await storeOf(c).documentReviewSnapshot(
      asDocumentSlug(data.slug),
    );
    const db = connectControlDb(c.env.DB);

    const commentAuthorIds = new Set<string>();
    for (const thread of snapshot.comments) {
      commentAuthorIds.add(thread.createdBy);
      for (const comment of thread.comments) {
        commentAuthorIds.add(comment.createdBy);
      }
    }

    const [commentNames, suggestionNames] = await Promise.all([
      resolveUserNames(db, [...commentAuthorIds]),
      resolveAuthorLabels(
        db,
        snapshot.suggestions.map((s) => s.createdBy),
      ),
    ]);

    return {
      doc: snapshot.doc === undefined ? undefined : docSnapshot(snapshot.doc),
      blocks: snapshot.blocks.found
        ? {
            found: true,
            docVersion: snapshot.blocks.docVersion,
            blocks: [...snapshot.blocks.blocks],
          }
        : { found: false },
      comments: {
        threads: [...snapshot.comments],
        names: Object.fromEntries(commentNames),
      },
      suggestions: {
        suggestions: [...snapshot.suggestions],
        names: Object.fromEntries(suggestionNames),
      },
    };
  });

export const getDocumentHistoryPage = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .validator(z.object({ slug: z.string().min(1) }))
  .handler(async ({ data, context }): Promise<DocumentHistoryResult> => {
    const c = srv(context);
    const snapshot = await storeOf(c).documentHistorySnapshot(
      asDocumentSlug(data.slug),
    );
    const names = await resolveUserNames(
      connectControlDb(c.env.DB),
      snapshot.history.map((e) => e.changedBy),
    );
    return {
      doc: snapshot.doc === undefined ? undefined : docSnapshot(snapshot.doc),
      history: snapshot.history.map((e) =>
        compact({
          docVersion: e.docVersion,
          changedAt: e.changedAt,
          changedBy: e.changedBy,
          changedByName: names.get(e.changedBy),
          diffSummary: e.diffSummary,
          markdown: e.markdown,
          retained: e.retained,
        }),
      ),
    };
  });
