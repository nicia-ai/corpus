import {
  asFileSlug,
  asFolderSlug,
  type CorpusSlug,
  type DocumentSlug,
  type FileSlug,
} from "../../ids";
import {
  fileCreated,
  fileDeleted,
  fileMoved,
} from "../../store/domain/change-events";
import {
  corpusRelativePath,
  type CorpusLocation,
} from "../../store/domain/corpus-drive";
import {
  type FileFormat,
  pastedFileName,
  uniqueFileName,
} from "../../store/domain/file-kinds";
import type { PlaceFileResult } from "../../store/repos/folder-repo";
import { MAX_PROJECT_FILE_BYTES } from "../../util";
import type { CommandOutcome, ProjectCommandContext } from "../command";

import {
  corpusOfDocument,
  corpusOfFolder,
  resolveCorpusFolder,
} from "./corpus-tree";

// What an upload leaves behind in the DO. The bytes are already in R2 (the
// transport puts them FIRST; see `src/files/http.ts`), so this is the
// metadata half: one transaction that names the file, places it in its
// folder, and records the change.
export type AttachFileInput = Readonly<{
  // The page the file is uploaded for: it lands in that page's own folder.
  documentSlug: DocumentSlug;
  // The normalized name the client chose, or undefined for a nameless upload
  // (a pasted screenshot), which is named from its bytes.
  name: string | undefined;
  contentHash: string;
  size: number;
  format: FileFormat;
  changedBy: string;
}>;

export type StoredFileView = Readonly<{
  slug: string;
  name: string;
  // Relative to the corpus root, like a document's path.
  path: string;
  corpusSlug: CorpusSlug;
  contentHash: string;
  contentType: string;
  size: number;
}>;

export type AttachFileResult = Readonly<
  | { ok: true; created: boolean; file: StoredFileView }
  | { ok: false; reason: "document-missing" | "quota-exceeded" }
>;

// Attach a file next to a page. Idempotent on content: the same bytes already
// in that folder return the existing file untouched (a double paste is one
// file, and a retry after a lost response writes nothing). A different file
// whose name is taken gets `name-2.ext`; the response says what it ended up
// called, because the caller's link must use that.
export async function attachFileCommand(
  ctx: ProjectCommandContext,
  input: AttachFileInput,
): Promise<CommandOutcome<AttachFileResult>> {
  const chain = await ctx.u.folders.documentFolderChain(input.documentSlug);
  const home = chain.at(-1);
  const corpusSlug = await corpusOfDocument(ctx.u, input.documentSlug);
  if (home === undefined || corpusSlug === undefined) {
    return {
      result: { ok: false, reason: "document-missing" },
      changes: [],
    };
  }
  const folderNames = chain.map((folder) => folder.name);
  const view = (
    file: Readonly<{
      slug: string;
      filename: string;
      contentHash: string;
      contentType: string;
      size: number;
    }>,
  ): StoredFileView => ({
    slug: file.slug,
    name: file.filename,
    path: corpusRelativePath(folderNames, file.filename),
    corpusSlug,
    contentHash: file.contentHash,
    contentType: file.contentType,
    size: file.size,
  });

  const existing = (await ctx.u.files.liveIn(home.slug)).find(
    (file) => file.contentHash === input.contentHash,
  );
  if (existing !== undefined) {
    return {
      result: { ok: true, created: false, file: view(existing) },
      changes: [],
    };
  }

  if ((await ctx.u.files.liveBytes()) + input.size > MAX_PROJECT_FILE_BYTES) {
    return { result: { ok: false, reason: "quota-exceeded" }, changes: [] };
  }

  const filename = uniqueFileName(
    input.name ?? pastedFileName(input.contentHash, input.format),
    await ctx.u.folders.occupiedNames(asFolderSlug(home.slug)),
  );
  const node = await ctx.u.files.create(
    {
      slug: asFileSlug(crypto.randomUUID()),
      filename,
      contentHash: input.contentHash,
      contentType: input.format.contentType,
      size: input.size,
      createdAt: ctx.now,
    },
    asFolderSlug(home.slug),
  );
  if (node === undefined) {
    return {
      result: { ok: false, reason: "document-missing" },
      changes: [],
    };
  }
  return {
    result: { ok: true, created: true, file: view(node) },
    changes: [
      fileCreated({
        fileSlug: asFileSlug(node.slug),
        corpusSlug,
        filename,
        contentHash: input.contentHash,
        contentType: input.format.contentType,
        size: input.size,
        changedBy: input.changedBy,
        changedAt: ctx.now,
      }),
    ],
  };
}

export type DeleteFileResult = Readonly<
  { ok: true } | { ok: false; reason: "missing" }
>;

// Delete a file: soft, like a page. It leaves its folder (so its name is
// free again) and is stamped `deletedAt`; the node, and so the bytes in R2,
// stay until the retention reaper and the orphan sweep reclaim them.
export async function deleteFileCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{ slug: FileSlug; changedBy: string }>,
): Promise<CommandOutcome<DeleteFileResult>> {
  const folderSlug = await ctx.u.files.folderOf(input.slug);
  const corpusSlug =
    folderSlug === undefined
      ? undefined
      : await corpusOfFolder(ctx.u, asFolderSlug(folderSlug));
  if (
    corpusSlug === undefined ||
    !(await ctx.u.files.deleteOne(input.slug, ctx.now))
  ) {
    return { result: { ok: false, reason: "missing" }, changes: [] };
  }
  return {
    result: { ok: true },
    changes: [
      fileDeleted({
        fileSlug: input.slug,
        corpusSlug,
        changedBy: input.changedBy,
        changedAt: ctx.now,
      }),
    ],
  };
}

// Move a file to another folder or corpus. One corpus per file holds by
// construction (a file is in exactly one folder); a name already taken in
// the destination refuses the move, exactly as it does for a page. The bytes
// and the content hash never change.
export async function moveFileCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{
    slug: FileSlug;
    destination: CorpusLocation;
    changedBy: string;
  }>,
): Promise<CommandOutcome<PlaceFileResult>> {
  const missing = {
    result: { ok: false, reason: "missing" },
    changes: [],
  } as const;
  const destination = await resolveCorpusFolder(ctx.u, input.destination);
  const fromFolder = await ctx.u.files.folderOf(input.slug);
  const node = await ctx.u.files.find(input.slug);
  if (
    destination === undefined ||
    fromFolder === undefined ||
    node === undefined
  ) {
    return missing;
  }
  const from = await corpusOfFolder(ctx.u, asFolderSlug(fromFolder));
  const result = await ctx.u.folders.placeFile(input.slug, destination);
  if (!result.ok || !result.changed || from === undefined) {
    return { result, changes: [] };
  }
  return {
    result,
    changes: [
      fileMoved({
        fileSlug: input.slug,
        corpusSlug: input.destination.corpusSlug,
        fromCorpusSlug: from,
        filename: node.filename,
        contentHash: node.contentHash,
        changedBy: input.changedBy,
        changedAt: ctx.now,
      }),
    ],
  };
}
