import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { entitlementsOf } from "@/control/entitlements";
import {
  asCollectionSlug,
  asDocumentSlug,
  asFolderSlug,
  type FolderSlug,
} from "@/ids";
import { projectMiddleware } from "@/lib/middleware";
import { changedBy, storeOf } from "@/lib/server/shared";
import { assertServerContext as srv } from "@/lib/server-context";
import type { ImportAndLinkResult, ImportSummary } from "@/project-store";
import { folderNameHasSeparator } from "@/store/domain/folders";
import type {
  DeleteFolderResult,
  MoveFolderResult,
  PlaceDocumentResult,
  RenameFolderResult,
} from "@/store/repos/folder-repo";
import { utf8Bytes } from "@/util";

// Bound a single upload so one request can't open an unbounded number
// of per-document transactions.
const MAX_UPLOAD_ENTRIES = 5_000;

// Plain DTO mirror of FolderView (DO returns carry branding). One flat
// row per folder; the client builds the nesting from `parentSlug`.
export type FolderRow = Readonly<{
  slug: FolderSlug;
  name: string;
  parentSlug: FolderSlug | null;
  position: number;
}>;

export type CreateFolderResult = Readonly<
  { ok: true; slug: FolderSlug } | { ok: false; reason: "segment-collision" }
>;

const slugInput = z.string().min(1);
// `null` = project root; absent treated as root.
const parentInput = slugInput.nullable().optional();
const importEntryInput = z.object({
  path: z.string().trim().min(1),
  markdown: z.string(),
});
const importLinkInput = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }),
  z.object({
    mode: z.literal("existing"),
    slug: slugInput.transform(asCollectionSlug),
  }),
  z.object({ mode: z.literal("new"), name: z.string().trim().min(1) }),
]);
// A folder name is a single path segment; reject separators so it can't
// be re-split into the wrong nesting when names are joined into a path.
const folderNameInput = z
  .string()
  .trim()
  .min(1)
  .refine(
    (v) => !folderNameHasSeparator(v),
    "folder name cannot contain a path separator",
  );

type ImportEntry = Readonly<z.infer<typeof importEntryInput>>;

export type { ImportAndLinkResult };

async function assertImportQuota(
  context: ReturnType<typeof srv>,
  entries: readonly ImportEntry[],
): Promise<void> {
  await entitlementsOf(context).assertWithinQuota({
    action: "document_create",
    userId: context.project?.userId,
    organizationId: context.project?.organizationId,
    projectId: context.project?.projectId,
    amount: entries.length,
    bytes: entries.reduce((sum, e) => sum + utf8Bytes(e.markdown), 0),
  });
}

export const getFolderList = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .handler(async ({ context }): Promise<FolderRow[]> => {
    const folders = await storeOf(srv(context)).listFolders();
    return folders.map((f) => ({
      slug: asFolderSlug(f.slug),
      name: f.name,
      parentSlug: f.parentSlug === null ? null : asFolderSlug(f.parentSlug),
      position: f.position,
    }));
  });

export const createFolder = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(z.object({ name: folderNameInput, parentSlug: parentInput }))
  .handler(async ({ data, context }): Promise<CreateFolderResult> => {
    const r = await storeOf(srv(context)).createFolder(
      data.name,
      data.parentSlug == null ? null : asFolderSlug(data.parentSlug),
    );
    return r.ok ? { ok: true, slug: asFolderSlug(r.slug) } : r;
  });

export const renameFolder = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(z.object({ slug: slugInput, name: folderNameInput }))
  .handler(async ({ data, context }): Promise<RenameFolderResult> => {
    const c = srv(context);
    return storeOf(c).renameFolder(
      asFolderSlug(data.slug),
      data.name,
      changedBy(c),
    );
  });

export const moveFolder = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(z.object({ slug: slugInput, newParentSlug: parentInput }))
  .handler(async ({ data, context }): Promise<MoveFolderResult> => {
    const c = srv(context);
    return storeOf(c).moveFolder(
      asFolderSlug(data.slug),
      data.newParentSlug == null ? null : asFolderSlug(data.newParentSlug),
      changedBy(c),
    );
  });

export const deleteFolder = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(z.object({ slug: slugInput }))
  .handler(async ({ data, context }): Promise<DeleteFolderResult> => {
    const c = srv(context);
    return storeOf(c).deleteFolder(asFolderSlug(data.slug), changedBy(c));
  });

// Place (or re-place) a document in a folder. `folderSlug: null` = root.
export const placeDocumentInFolder = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(
    z.object({ documentSlug: slugInput, folderSlug: slugInput.nullable() }),
  )
  .handler(async ({ data, context }): Promise<PlaceDocumentResult> => {
    const c = srv(context);
    return storeOf(c).placeDocumentInFolder(
      asDocumentSlug(data.documentSlug),
      data.folderSlug === null ? null : asFolderSlug(data.folderSlug),
      changedBy(c),
    );
  });

export type MoveDocumentsResult = Readonly<{
  moved: number;
  failed: number;
}>;

// Bulk move the selected documents into one folder (`null` = root) — the
// picker's alternative to dragging when there are many files.
export const moveDocumentsToFolder = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(
    z.object({
      slugs: z.array(slugInput).min(1),
      folderSlug: slugInput.nullable(),
    }),
  )
  .handler(async ({ data, context }): Promise<MoveDocumentsResult> => {
    const c = srv(context);
    return storeOf(c).placeDocumentsInFolder(
      data.slugs.map(asDocumentSlug),
      data.folderSlug === null ? null : asFolderSlug(data.folderSlug),
      changedBy(c),
    );
  });

// Folder→collection links: include a whole folder (transitively) in a
// collection. Shares the document `includes` position space. Delivery
// defaults to the uniform domain default ("core") like every other
// attach surface — a caller that wants a folder to be reference-only
// (e.g. a bulk import that shouldn't flood read_collection) passes it
// explicitly, so the default never diverges by entry point.
export const attachFolderToCollection = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(
    z.object({
      collectionSlug: slugInput,
      folderSlug: slugInput,
      position: z.number().int().nonnegative(),
      delivery: z.enum(["core", "reference"]).default("core"),
    }),
  )
  .handler(async ({ data, context }): Promise<{ ok: boolean }> => {
    const c = srv(context);
    return storeOf(c).attachFolderToCollection(
      asCollectionSlug(data.collectionSlug),
      asFolderSlug(data.folderSlug),
      data.position,
      changedBy(c),
      data.delivery,
    );
  });

// Flip a folder link's delivery tier in place (mirrors `setMemberDelivery`
// for documents) — a position-free update so the toggle never reorders.
export const setFolderLinkDelivery = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(
    z.object({
      collectionSlug: slugInput,
      folderSlug: slugInput,
      delivery: z.enum(["core", "reference"]),
    }),
  )
  .handler(async ({ data, context }): Promise<{ ok: boolean }> => {
    const c = srv(context);
    return storeOf(c).setFolderLinkDelivery(
      asCollectionSlug(data.collectionSlug),
      asFolderSlug(data.folderSlug),
      data.delivery,
      changedBy(c),
    );
  });

export const detachFolderFromCollection = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(z.object({ collectionSlug: slugInput, folderSlug: slugInput }))
  .handler(async ({ data, context }): Promise<{ ok: boolean }> => {
    const c = srv(context);
    return storeOf(c).detachFolderFromCollection(
      asCollectionSlug(data.collectionSlug),
      asFolderSlug(data.folderSlug),
      changedBy(c),
    );
  });

// Bulk folder upload: a flat list of {path, markdown} (the client walks
// the picked directory tree). Each entry is its own atomic import;
// idempotent on path. Returns a created/updated/failed summary.
export const importDocuments = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(
    z.object({
      entries: z.array(importEntryInput).min(1).max(MAX_UPLOAD_ENTRIES),
    }),
  )
  .handler(async ({ data, context }): Promise<ImportSummary> => {
    const c = srv(context);
    // Bulk import is gated like a document create (approximate, per the
    // entitlements port contract): one pre-flight assertion so a hosted
    // tier impl can reject an over-limit project before the batch opens
    // any per-document transaction. OSS default is unlimited.
    await assertImportQuota(c, data.entries);
    return storeOf(c).importDocuments(data.entries, changedBy(c));
  });

export const importDocumentsAndLink = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(
    z.object({
      entries: z.array(importEntryInput).min(1).max(MAX_UPLOAD_ENTRIES),
      link: importLinkInput,
    }),
  )
  .handler(async ({ data, context }): Promise<ImportAndLinkResult> => {
    const c = srv(context);
    await assertImportQuota(c, data.entries);
    return storeOf(c).importDocumentsAndLink({
      entries: data.entries,
      link: data.link,
      changedBy: changedBy(c),
    });
  });
