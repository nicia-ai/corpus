import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  asCorpusSlug,
  asDocumentSlug,
  asFolderSlug,
  type CorpusSlug,
  type DocumentSlug,
  type FolderSlug,
} from "@/ids";
import { projectMiddleware } from "@/lib/middleware";
import { changedBy, storeOf } from "@/lib/server/shared";
import { assertServerContext as srv } from "@/lib/server-context";
import type { SeedResult } from "@/project-store";
import {
  corpusDelivery,
  type CollectionDelivery,
} from "@/store/domain/collection-expand";
import { alwaysIncludeBudgetTokensZ, compact, slugify } from "@/util";

export type CorpusMeta = Readonly<{
  slug: CorpusSlug;
  name: string;
  description?: string;
}>;
// Corpora list row: CorpusMeta + how many documents are attached (the
// "builder" needs this at a glance). One round trip, like getDocumentList.
export type CorpusListItem = Readonly<{
  slug: CorpusSlug;
  name: string;
  description?: string;
  documentCount: number;
}>;
// A resolved (corpus, document) membership pair — the document is in
// the corpus directly OR via a linked folder. Backs every
// "how many documents" / "in how many corpora" count.
export type CorpusMember = Readonly<{
  corpusSlug: CorpusSlug;
  documentSlug: DocumentSlug;
}>;
// Provenance-aware builder view. `direct` members carry an `includes`
// edge (detach/reorder individually); `viaFolder` members are pulled in
// by a linked folder (manage them by detaching the folder).
export type CorpusMemberRow = Readonly<{
  slug: DocumentSlug;
  title: string;
  docVersion: number;
  size: number;
  updatedAt: string;
  direct: boolean;
  position: number;
  delivery: CollectionDelivery;
  viaFolder?: FolderSlug;
}>;
export type ColFolderLink = Readonly<{
  slug: FolderSlug;
  name: string;
  position: number;
  delivery: CollectionDelivery;
}>;
export type ColDetail = Readonly<
  | { found: false }
  | {
      found: true;
      name: string;
      description?: string;
      alwaysIncludeBudgetTokens: number;
      folders: readonly ColFolderLink[];
      members: readonly CorpusMemberRow[];
    }
>;

// Lightweight head-node lookup for callers that need name/description/
// budget without the full member structure (e.g. the MCP setup page).
export type CorpusMetaResult = Readonly<
  | { found: false }
  | {
      found: true;
      name: string;
      description?: string;
      alwaysIncludeBudgetTokens: number;
    }
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
    // One member row per resolved (corpus, document), so counting
    // rows per corpus yields the folder-aware document count.
    const countByCol = new Map<string, number>();
    for (const m of members) {
      countByCol.set(m.corpusSlug, (countByCol.get(m.corpusSlug) ?? 0) + 1);
    }
    return corpora.map((c) =>
      compact({
        slug: asCorpusSlug(c.slug),
        name: c.name,
        description: c.description,
        documentCount: countByCol.get(c.slug) ?? 0,
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
    const r = await storeOf(c).createCorpus(
      compact({
        slug: asCorpusSlug(slugify(data.name)),
        name: data.name,
        description: data.description,
        changedBy: changedBy(c),
      }),
    );
    return { slug: asCorpusSlug(r.slug) };
  });

// Edit a corpus's name/description. Slug is identity and is never
// changed here (renaming the name does not re-slug). An empty
// description clears it.
export const updateCorpus = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(
    z.object({
      slug: z.string().min(1),
      name: z.string().trim().min(1),
      description: z.string().trim().optional(),
      alwaysIncludeBudgetTokens: alwaysIncludeBudgetTokensZ,
    }),
  )
  .handler(async ({ data, context }): Promise<{ ok: boolean }> => {
    const c = srv(context);
    return storeOf(c).updateCorpus(
      compact({
        slug: asCorpusSlug(data.slug),
        name: data.name,
        description: data.description,
        alwaysIncludeBudgetTokens: data.alwaysIncludeBudgetTokens,
        changedBy: changedBy(c),
      }),
    );
  });

// One round trip for the corpus builder: resolved members with
// direct-vs-folder provenance plus the linked-folder list. Replaces the
// old readCorpus + getDocuments double call on the corpus route.
export const getCorpusDetail = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .validator(z.object({ slug: z.string().min(1) }))
  .handler(async ({ data, context }): Promise<ColDetail> => {
    const r = await storeOf(srv(context)).corpusStructure(
      asCorpusSlug(data.slug),
    );
    if (!r.found) return { found: false };
    return {
      found: true,
      ...compact({ description: r.description }),
      name: r.name,
      alwaysIncludeBudgetTokens: r.alwaysIncludeBudgetTokens,
      folders: r.folders.map((f) => ({
        slug: asFolderSlug(f.slug),
        name: f.name,
        position: f.position,
        delivery: corpusDelivery(f.delivery),
      })),
      members: r.members.map((m) =>
        compact({
          slug: asDocumentSlug(m.slug),
          title: m.title,
          docVersion: m.docVersion,
          size: m.size,
          updatedAt: m.updatedAt,
          direct: m.direct,
          position: m.position,
          delivery: corpusDelivery(m.delivery),
          viaFolder:
            m.viaFolder === undefined ? undefined : asFolderSlug(m.viaFolder),
        }),
      ),
    };
  });

// Sibling of getCorpusDetail for callers that only need head-node
// metadata (name/description/budget). One DO read, no folder subtree
// walk, no blob hydration — call this from pages whose feature surface
// doesn't depend on the resolved member structure.
export const getCorpusMeta = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .validator(z.object({ slug: z.string().min(1) }))
  .handler(async ({ data, context }): Promise<CorpusMetaResult> => {
    return storeOf(srv(context)).corpusMeta(asCorpusSlug(data.slug));
  });

export const attachDocument = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(
    z.object({
      corpusSlug: z.string().min(1),
      documentSlug: z.string().min(1),
      position: z.number().int().nonnegative(),
      delivery: z.enum(["core", "reference"]).default("core"),
    }),
  )
  .handler(async ({ data, context }): Promise<{ ok: boolean }> => {
    const c = srv(context);
    const r = await storeOf(c).attachDocument(
      asCorpusSlug(data.corpusSlug),
      asDocumentSlug(data.documentSlug),
      data.position,
      changedBy(c),
      data.delivery,
    );
    return { ok: r.ok };
  });

// Flip a member's delivery tier in place. Distinct from `attachDocument`
// so the UI never has to round-trip a position it only knows as the
// resolved index (which would reorder folder-linked members).
export const setMemberDelivery = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(
    z.object({
      corpusSlug: z.string().min(1),
      documentSlug: z.string().min(1),
      delivery: z.enum(["core", "reference"]),
    }),
  )
  .handler(async ({ data, context }): Promise<{ ok: boolean }> => {
    const c = srv(context);
    const r = await storeOf(c).setMemberDelivery(
      asCorpusSlug(data.corpusSlug),
      asDocumentSlug(data.documentSlug),
      data.delivery,
      changedBy(c),
    );
    return { ok: r.ok };
  });

export const detachDocument = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(
    z.object({
      corpusSlug: z.string().min(1),
      documentSlug: z.string().min(1),
    }),
  )
  .handler(async ({ data, context }): Promise<{ ok: boolean }> => {
    const c = srv(context);
    const r = await storeOf(c).detachDocument(
      asCorpusSlug(data.corpusSlug),
      asDocumentSlug(data.documentSlug),
      changedBy(c),
    );
    return { ok: r.ok };
  });

export const reorderCorpusDocuments = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(
    z.object({
      corpusSlug: z.string().min(1),
      orderedDocumentSlugs: z.array(z.string().min(1)),
    }),
  )
  .handler(async ({ data, context }): Promise<{ ok: boolean }> => {
    const c = srv(context);
    const r = await storeOf(c).reorderCorpusDocuments(
      asCorpusSlug(data.corpusSlug),
      data.orderedDocumentSlugs.map(asDocumentSlug),
      changedBy(c),
    );
    return { ok: r.ok };
  });

// Atomic, guarded example seed — one round-trip, all-or-nothing, no-op if
// the project already has data (double-click / populated-project safe).
export const seedExample = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .handler(async ({ context }): Promise<SeedResult> => {
    const c = srv(context);
    return storeOf(c).seedExample(changedBy(c));
  });
