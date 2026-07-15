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
import type {
  DocSnapshot,
  DocVersionEntry,
  DocVersionMeta,
} from "@/lib/server/documents";
import { changedBy, storeOf } from "@/lib/server/shared";
import type { SuggestionsResult } from "@/lib/server/suggestions";
import { assertServerContext as srv } from "@/lib/server-context";
import { compact } from "@/util";

export type DocumentReviewResult = Readonly<{
  doc: DocSnapshot | undefined;
  blocks: DocumentBlocksResult;
  comments: CommentsResult;
  suggestions: SuggestionsResult;
  // The viewing user's id, so the client can tell its own writes' echoes from
  // genuine remote changes (web writes stamp this same id as the actor).
  viewerId: string;
  docRefs: readonly Readonly<{ slug: string; path: string }>[];
}>;

export type DocumentHistoryResult = Readonly<{
  doc: DocSnapshot | undefined;
  history: readonly DocVersionMeta[];
  active: DocVersionEntry | undefined;
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
    const store = storeOf(c);
    const [snapshot, docRefs] = await Promise.all([
      store.documentReviewSnapshot(asDocumentSlug(data.slug)),
      // Link metadata improves authoring but is not allowed to make the
      // canonical document unavailable if that cosmetic lookup fails.
      store.listDocumentRefs().catch(() => []),
    ]);
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
      viewerId: changedBy(c),
      docRefs: docRefs.map((ref) => ({ slug: ref.slug, path: ref.path })),
    };
  });

export const getDocumentHistoryPage = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .validator(
    z.object({
      slug: z.string().min(1),
      version: z.number().int().positive().optional(),
    }),
  )
  .handler(async ({ data, context }): Promise<DocumentHistoryResult> => {
    const c = srv(context);
    const snapshot = await storeOf(c).documentHistoryPageSnapshot(
      asDocumentSlug(data.slug),
      data.version,
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
          retained: e.retained,
        }),
      ),
      active:
        snapshot.active === undefined
          ? undefined
          : compact({
              ...snapshot.active,
              changedByName: names.get(snapshot.active.changedBy),
            }),
    };
  });

export const getDocumentHistoryVersion = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .validator(
    z.object({
      slug: z.string().min(1),
      version: z.number().int().positive(),
    }),
  )
  .handler(async ({ data, context }): Promise<DocVersionEntry | undefined> => {
    const c = srv(context);
    const entry = await storeOf(c).documentHistoryVersion(
      asDocumentSlug(data.slug),
      data.version,
    );
    if (entry === undefined) return undefined;
    const names = await resolveUserNames(connectControlDb(c.env.DB), [
      entry.changedBy,
    ]);
    return compact({
      ...entry,
      changedByName: names.get(entry.changedBy),
    });
  });
