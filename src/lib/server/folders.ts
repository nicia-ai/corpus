import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { connectControlDb } from "@/control/db";
import { revokeEmbassiesForDocuments } from "@/control/embassies";
import { entitlementsOf } from "@/control/entitlements";
import {
  asCorpusSlug,
  asDocumentSlug,
  asFolderSlug,
  type CorpusSlug,
  type FolderSlug,
} from "@/ids";
import { projectMiddleware } from "@/lib/middleware";
import { changedBy, storeOf } from "@/lib/server/shared";
import { assertServerContext as srv } from "@/lib/server-context";
import type {
  ImportDestination,
  ImportIntoCorpusResult,
  ImportSummary,
  MoveDocumentsResult,
} from "@/project-store/contracts";
import type { CorpusLocation } from "@/store/domain/corpus-drive";
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

// Plain DTO mirror of CorpusFolderView (DO returns carry branding). One
// flat row per folder, tagged with its corpus; the client builds the
// nesting from `parentSlug` (null = directly in the corpus root).
export type FolderRow = Readonly<{
  slug: FolderSlug;
  name: string;
  corpusSlug: CorpusSlug;
  parentSlug: FolderSlug | null;
}>;

export type CreateFolderResult = Readonly<
  | { ok: true; slug: FolderSlug }
  | { ok: false; reason: "segment-collision" | "missing" }
>;

export type { ImportIntoCorpusResult, ImportSummary, MoveDocumentsResult };

const slugInput = z.string().min(1);
// A place in a corpus: `folderSlug: null` (or absent) is the corpus root.
const locationInput = z
  .object({ corpusSlug: slugInput, folderSlug: slugInput.nullish() })
  .transform((v): CorpusLocation => ({
    corpusSlug: asCorpusSlug(v.corpusSlug),
    folderSlug: v.folderSlug == null ? null : asFolderSlug(v.folderSlug),
  }));
const importEntryInput = z.object({
  path: z.string().trim().min(1),
  markdown: z.string(),
});
const importDestinationInput = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("default") }),
  z.object({
    mode: z.literal("existing"),
    slug: slugInput.transform(asCorpusSlug),
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
      corpusSlug: asCorpusSlug(f.corpusSlug),
      parentSlug: f.parentSlug === null ? null : asFolderSlug(f.parentSlug),
    }));
  });

export const createFolder = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(z.object({ name: folderNameInput, location: locationInput }))
  .handler(async ({ data, context }): Promise<CreateFolderResult> => {
    const r = await storeOf(srv(context)).createFolder(
      data.name,
      data.location,
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

// Move a folder within its corpus or into another one. Any project member
// may; everything under the folder travels with it.
export const moveFolder = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(z.object({ slug: slugInput, destination: locationInput }))
  .handler(async ({ data, context }): Promise<MoveFolderResult> => {
    const c = srv(context);
    return storeOf(c).moveFolder(
      asFolderSlug(data.slug),
      data.destination,
      changedBy(c),
    );
  });

export const deleteFolder = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(z.object({ slug: slugInput }))
  .handler(async ({ data, context }): Promise<DeleteFolderResult> => {
    const c = srv(context);
    const result = await storeOf(c).deleteFolder(
      asFolderSlug(data.slug),
      changedBy(c),
    );
    if (result.ok && c.project !== undefined) {
      await revokeEmbassiesForDocuments(connectControlDb(c.env.DB), {
        projectId: c.project.projectId,
        documentSlugs: result.documentSlugs,
      });
    }
    return result;
  });

// Move one document to a place in any corpus. Moving it out of the
// default corpus into a named one publishes it; moving it back
// unpublishes it.
export const moveDocument = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(z.object({ documentSlug: slugInput, destination: locationInput }))
  .handler(async ({ data, context }): Promise<PlaceDocumentResult> => {
    const c = srv(context);
    return storeOf(c).moveDocument(
      asDocumentSlug(data.documentSlug),
      data.destination,
      changedBy(c),
    );
  });

// Bulk move the selected documents into one place — the picker's
// alternative to dragging when there are many files.
export const moveDocuments = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(
    z.object({
      slugs: z.array(slugInput).min(1),
      destination: locationInput,
    }),
  )
  .handler(async ({ data, context }): Promise<MoveDocumentsResult> => {
    const c = srv(context);
    return storeOf(c).moveDocuments(
      data.slugs.map(asDocumentSlug),
      data.destination,
      changedBy(c),
    );
  });

// Bulk folder upload into one corpus: a flat list of {path, markdown}
// (the client walks the picked directory tree), paths relative to the
// corpus root. Each entry is its own atomic import; idempotent on path.
// `undefined` = the named corpus no longer exists.
export const importIntoCorpus = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(
    z.object({
      entries: z.array(importEntryInput).min(1).max(MAX_UPLOAD_ENTRIES),
      destination: importDestinationInput,
    }),
  )
  .handler(
    async ({ data, context }): Promise<ImportIntoCorpusResult | undefined> => {
      const c = srv(context);
      // Gated like a document create (approximate, per the entitlements
      // port contract): one pre-flight assertion so a hosted tier impl can
      // reject an over-limit project before the batch opens any
      // per-document transaction. OSS default is unlimited.
      await assertImportQuota(c, data.entries);
      const destination: ImportDestination = data.destination;
      return storeOf(c).importIntoCorpus({
        entries: data.entries,
        destination,
        changedBy: changedBy(c),
      });
    },
  );
