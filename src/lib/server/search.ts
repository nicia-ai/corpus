import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { asDocumentSlug, type DocumentSlug } from "@/ids";
import { projectMiddleware } from "@/lib/middleware";
import { storeOf } from "@/lib/server/shared";
import { assertServerContext as srv } from "@/lib/server-context";
import { compact } from "@/util";

// Full-text search over the project's live document heads. Membership-
// gated (any member can search — same visibility as the documents list);
// the match scan itself lives in the DO (searchDocumentsProjection).

export type SearchHit = Readonly<{
  slug: DocumentSlug;
  title: string;
  path: string;
  docVersion: number;
  field: "title" | "body";
  snippet: string;
  // Offsets into `snippet` for the matched span; absent when the snippet
  // is a body-head preview for a title-only match.
  matchStart?: number;
  matchEnd?: number;
}>;

export const searchDocuments = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .validator(z.object({ query: z.string().max(200) }))
  .handler(async ({ data, context }): Promise<SearchHit[]> => {
    const hits = await storeOf(srv(context)).searchDocuments(data.query);
    return hits.map((h) =>
      compact({
        slug: asDocumentSlug(h.slug),
        title: h.title,
        path: h.path,
        docVersion: h.docVersion,
        field: h.field,
        snippet: h.snippet,
        matchStart: h.matchStart,
        matchEnd: h.matchEnd,
      }),
    );
  });
