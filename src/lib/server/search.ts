import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { asDocumentSlug, type DocumentSlug } from "@/ids";
import { projectMiddleware } from "@/lib/middleware";
import { storeOf } from "@/lib/server/shared";
import { assertServerContext as srv } from "@/lib/server-context";

// Full-text search over the project's live document heads. Membership-
// gated (any member can search — same visibility as the documents list);
// the FTS5 query itself lives in the DO (searchDocumentsProjection).

export type SearchHit = Readonly<{
  slug: DocumentSlug;
  title: string;
  path: string;
  // Highlighted excerpt with `<mark>…</mark>` around matched terms; empty
  // when the backend produced no fragment.
  snippet: string;
}>;

export const searchDocuments = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .validator(z.object({ query: z.string().max(200) }))
  .handler(async ({ data, context }): Promise<SearchHit[]> => {
    const hits = await storeOf(srv(context)).searchDocuments(data.query);
    return hits.map((h) => ({
      slug: asDocumentSlug(h.slug),
      title: h.title,
      path: h.path,
      snippet: h.snippet,
    }));
  });
