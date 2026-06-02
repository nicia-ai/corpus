import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  asCollectionSlug,
  asDocumentSlug,
  asFolderSlug,
  type CollectionSlug,
  type DocumentSlug,
  type FolderSlug,
} from "@/ids";
import { projectMiddleware } from "@/lib/middleware";
import { changedBy, storeOf } from "@/lib/server/shared";
import { assertServerContext as srv } from "@/lib/server-context";
import type { SeedResult } from "@/project-store";
import {
  collectionDelivery,
  type CollectionDelivery,
} from "@/store/domain/collection-expand";
import { alwaysIncludeBudgetTokensZ, compact, slugify } from "@/util";

export type ColMeta = Readonly<{
  slug: CollectionSlug;
  name: string;
  description?: string;
}>;
// Collections list row: ColMeta + how many documents are attached (the
// "builder" needs this at a glance). One round trip, like getDocumentList.
export type ColListItem = Readonly<{
  slug: CollectionSlug;
  name: string;
  description?: string;
  documentCount: number;
}>;
export type Attachment = Readonly<{
  collectionSlug: CollectionSlug;
  documentSlug: DocumentSlug;
  position: number;
}>;
// Provenance-aware builder view. `direct` members carry an `includes`
// edge (detach/reorder individually); `viaFolder` members are pulled in
// by a linked folder (manage them by detaching the folder).
export type ColMemberRow = Readonly<{
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
      members: readonly ColMemberRow[];
    }
>;

// Lightweight head-node lookup for callers that need name/description/
// budget without the full member structure (e.g. the MCP setup page).
export type ColMetaResult = Readonly<
  | { found: false }
  | {
      found: true;
      name: string;
      description?: string;
      alwaysIncludeBudgetTokens: number;
    }
>;

export const colMetas = (
  rows: readonly { slug: string; name: string; description?: string }[],
): ColMeta[] =>
  rows.map((c) =>
    compact({
      slug: asCollectionSlug(c.slug),
      name: c.name,
      description: c.description,
    }),
  );

export const attachmentMetas = (
  rows: readonly {
    collectionSlug: string;
    documentSlug: string;
    position: number;
  }[],
): Attachment[] =>
  rows.map((a) => ({
    collectionSlug: asCollectionSlug(a.collectionSlug),
    documentSlug: asDocumentSlug(a.documentSlug),
    position: a.position,
  }));

export const getCollectionList = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .handler(async ({ context }): Promise<ColListItem[]> => {
    const store = storeOf(srv(context));
    const [collections, attachments] = await Promise.all([
      store.listCollections(),
      store.listAttachments(),
    ]);
    const countByCol = new Map<string, number>();
    for (const a of attachments) {
      countByCol.set(
        a.collectionSlug,
        (countByCol.get(a.collectionSlug) ?? 0) + 1,
      );
    }
    return collections.map((c) =>
      compact({
        slug: asCollectionSlug(c.slug),
        name: c.name,
        description: c.description,
        documentCount: countByCol.get(c.slug) ?? 0,
      }),
    );
  });

export const createCollection = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .inputValidator(
    z.object({ name: z.string().min(1), description: z.string().optional() }),
  )
  .handler(async ({ data, context }): Promise<{ slug: CollectionSlug }> => {
    const c = srv(context);
    const r = await storeOf(c).createCollection(
      compact({
        slug: asCollectionSlug(slugify(data.name)),
        name: data.name,
        description: data.description,
        changedBy: changedBy(c),
      }),
    );
    return { slug: asCollectionSlug(r.slug) };
  });

// Edit a collection's name/description. Slug is identity and is never
// changed here (renaming the name does not re-slug). An empty
// description clears it.
export const updateCollection = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .inputValidator(
    z.object({
      slug: z.string().min(1),
      name: z.string().trim().min(1),
      description: z.string().trim().optional(),
      alwaysIncludeBudgetTokens: alwaysIncludeBudgetTokensZ,
    }),
  )
  .handler(async ({ data, context }): Promise<{ ok: boolean }> => {
    const c = srv(context);
    return storeOf(c).updateCollection(
      compact({
        slug: asCollectionSlug(data.slug),
        name: data.name,
        description: data.description,
        alwaysIncludeBudgetTokens: data.alwaysIncludeBudgetTokens,
        changedBy: changedBy(c),
      }),
    );
  });

// One round trip for the collection builder: resolved members with
// direct-vs-folder provenance plus the linked-folder list. Replaces the
// old readCollection + getDocuments double call on the collection route.
export const getCollectionDetail = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .inputValidator(z.object({ slug: z.string().min(1) }))
  .handler(async ({ data, context }): Promise<ColDetail> => {
    const r = await storeOf(srv(context)).collectionStructure(
      asCollectionSlug(data.slug),
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
        delivery: collectionDelivery(f.delivery),
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
          delivery: collectionDelivery(m.delivery),
          viaFolder:
            m.viaFolder === undefined ? undefined : asFolderSlug(m.viaFolder),
        }),
      ),
    };
  });

// Sibling of getCollectionDetail for callers that only need head-node
// metadata (name/description/budget). One DO read, no folder subtree
// walk, no blob hydration — call this from pages whose feature surface
// doesn't depend on the resolved member structure.
export const getCollectionMeta = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .inputValidator(z.object({ slug: z.string().min(1) }))
  .handler(async ({ data, context }): Promise<ColMetaResult> => {
    return storeOf(srv(context)).collectionMeta(asCollectionSlug(data.slug));
  });

export const attachDocument = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .inputValidator(
    z.object({
      collectionSlug: z.string().min(1),
      documentSlug: z.string().min(1),
      position: z.number().int().nonnegative(),
      delivery: z.enum(["core", "reference"]).default("core"),
    }),
  )
  .handler(async ({ data, context }): Promise<{ ok: boolean }> => {
    const c = srv(context);
    const r = await storeOf(c).attachDocument(
      asCollectionSlug(data.collectionSlug),
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
  .inputValidator(
    z.object({
      collectionSlug: z.string().min(1),
      documentSlug: z.string().min(1),
      delivery: z.enum(["core", "reference"]),
    }),
  )
  .handler(async ({ data, context }): Promise<{ ok: boolean }> => {
    const c = srv(context);
    const r = await storeOf(c).setMemberDelivery(
      asCollectionSlug(data.collectionSlug),
      asDocumentSlug(data.documentSlug),
      data.delivery,
      changedBy(c),
    );
    return { ok: r.ok };
  });

export const detachDocument = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .inputValidator(
    z.object({
      collectionSlug: z.string().min(1),
      documentSlug: z.string().min(1),
    }),
  )
  .handler(async ({ data, context }): Promise<{ ok: boolean }> => {
    const c = srv(context);
    const r = await storeOf(c).detachDocument(
      asCollectionSlug(data.collectionSlug),
      asDocumentSlug(data.documentSlug),
      changedBy(c),
    );
    return { ok: r.ok };
  });

export const reorderCollectionDocuments = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .inputValidator(
    z.object({
      collectionSlug: z.string().min(1),
      orderedDocumentSlugs: z.array(z.string().min(1)),
    }),
  )
  .handler(async ({ data, context }): Promise<{ ok: boolean }> => {
    const c = srv(context);
    const r = await storeOf(c).reorderCollectionDocuments(
      asCollectionSlug(data.collectionSlug),
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
