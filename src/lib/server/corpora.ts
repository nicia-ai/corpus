import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  createCorpusClean,
  deleteCorpusAndCredentials,
} from "@/control/corpus-lifecycle";
import { connectControlDb } from "@/control/db";
import {
  asCorpusSlug,
  asDocumentSlug,
  asProjectId,
  type CorpusSlug,
  type DocumentSlug,
} from "@/ids";
import { projectMiddleware } from "@/lib/middleware";
import { changedBy, requireProjectOwner, storeOf } from "@/lib/server/shared";
import { assertServerContext as srv } from "@/lib/server-context";
import type { SeedResult } from "@/project-store";
import { CORPUS_DELETE_PAGE_MODES } from "@/project-store/contracts";
import { corpusIsServed } from "@/store/domain/corpus-drive";
import { compact, slugify } from "@/util";

export type CorpusMeta = Readonly<{
  slug: CorpusSlug;
  name: string;
  description?: string;
}>;
// Corpora list row: how many documents live in the corpus, and whether
// agents can read it — the default corpus is the drafts space and is not
// served. One round trip, like getDocumentList.
export type CorpusListItem = Readonly<{
  slug: CorpusSlug;
  name: string;
  description?: string;
  documentCount: number;
  served: boolean;
}>;
// One live (corpus, document) pair — a document lives in exactly one
// corpus. Backs every "how many documents" count.
export type CorpusMember = Readonly<{
  corpusSlug: CorpusSlug;
  documentSlug: DocumentSlug;
}>;

// Lightweight head-node lookup for callers that need name/description
// without the corpus's documents (e.g. the MCP setup page).
export type CorpusMetaResult = Readonly<
  | { found: false }
  | { found: true; name: string; description?: string; served: boolean }
>;

export type DeleteCorpusOutcome = Readonly<
  | { ok: true; archived: number; moved: number }
  | { ok: false; reason: "missing" | "default-corpus" }
>;

export const corpusMetas = (
  rows: readonly { slug: string; name: string; description?: string }[],
): CorpusMeta[] =>
  rows.map((c) =>
    compact({
      slug: asCorpusSlug(c.slug),
      name: c.name,
      description: c.description,
    }),
  );

export const corpusMemberMetas = (
  rows: readonly { corpusSlug: string; documentSlug: string }[],
): CorpusMember[] =>
  rows.map((m) => ({
    corpusSlug: asCorpusSlug(m.corpusSlug),
    documentSlug: asDocumentSlug(m.documentSlug),
  }));

export const getCorpusList = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .handler(async ({ context }): Promise<CorpusListItem[]> => {
    const c = srv(context);
    const store = storeOf(c);
    await store.ensureDefaultCorpus(changedBy(c));
    const [corpora, members] = await Promise.all([
      store.listCorpora(),
      store.listResolvedMembers(),
    ]);
    const countByCol = new Map<string, number>();
    for (const m of members) {
      countByCol.set(m.corpusSlug, (countByCol.get(m.corpusSlug) ?? 0) + 1);
    }
    return corpora.map((corpus) =>
      compact({
        slug: asCorpusSlug(corpus.slug),
        name: corpus.name,
        description: corpus.description,
        documentCount: countByCol.get(corpus.slug) ?? 0,
        served: corpusIsServed(asCorpusSlug(corpus.slug)),
      }),
    );
  });

export const createCorpus = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(
    z.object({ name: z.string().min(1), description: z.string().optional() }),
  )
  .handler(async ({ data, context }): Promise<{ slug: CorpusSlug }> => {
    const c = srv(context);
    const r = await createCorpusClean({
      db: connectControlDb(c.env.DB),
      store: storeOf(c),
      projectId: c.project?.projectId ?? asProjectId(""),
      corpus: compact({
        slug: asCorpusSlug(slugify(data.name)),
        name: data.name,
        description: data.description,
        changedBy: changedBy(c),
      }),
    });
    return { slug: asCorpusSlug(r.slug) };
  });

// Edit a corpus's name/description. Slug is identity and is never
// changed here (renaming the name does not re-slug, and no path changes).
// An empty description clears it.
export const updateCorpus = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(
    z.object({
      slug: z.string().min(1),
      name: z.string().trim().min(1),
      description: z.string().trim().optional(),
    }),
  )
  .handler(async ({ data, context }): Promise<{ ok: boolean }> => {
    const c = srv(context);
    return storeOf(c).updateCorpus(
      compact({
        slug: asCorpusSlug(data.slug),
        name: data.name,
        description: data.description,
        changedBy: changedBy(c),
      }),
    );
  });

// Delete a corpus and say what becomes of its pages: archived with it
// (recoverable, like any archived page) or moved to the default corpus as
// drafts. Owner-only: it also deletes the Connections bound to the corpus
// (and with them their OAuth grants and API keys), which is Connection
// administration. Ordering and what a failed step leaves behind are in
// `deleteCorpusAndCredentials`; the share links of archived pages go with
// the pages.
export const deleteCorpus = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(
    z.object({
      slug: z.string().min(1),
      pages: z.enum(CORPUS_DELETE_PAGE_MODES),
    }),
  )
  .handler(async ({ data, context }): Promise<DeleteCorpusOutcome> => {
    const c = srv(context);
    const project = requireProjectOwner(
      c.project,
      "Only a project owner can delete a corpus",
    );
    const result = await deleteCorpusAndCredentials({
      db: connectControlDb(c.env.DB),
      store: storeOf(c),
      projectId: project.projectId,
      input: {
        slug: asCorpusSlug(data.slug),
        pages: data.pages,
        changedBy: changedBy(c),
      },
    });
    return result.ok
      ? {
          ok: true,
          archived: result.archivedSlugs.length,
          moved: result.moved,
        }
      : result;
  });

// Sibling of getCorpusList for callers that only need one head node.
export const getCorpusMeta = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .validator(z.object({ slug: z.string().min(1) }))
  .handler(async ({ data, context }): Promise<CorpusMetaResult> => {
    const slug = asCorpusSlug(data.slug);
    const meta = await storeOf(srv(context)).corpusMeta(slug);
    return meta.found
      ? compact({
          found: true,
          name: meta.name,
          description: meta.description,
          served: corpusIsServed(slug),
        })
      : { found: false };
  });

// Atomic, guarded example seed — one round-trip, all-or-nothing, no-op if
// the project already has data (double-click / populated-project safe).
export const seedExample = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .handler(async ({ context }): Promise<SeedResult> => {
    const c = srv(context);
    return storeOf(c).seedExample(changedBy(c));
  });
