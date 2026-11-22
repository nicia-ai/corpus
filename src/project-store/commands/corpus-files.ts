import { ValidationError } from "../../errors";
import {
  asFileSlug,
  asFolderSlug,
  type CorpusSlug,
  type FileSlug,
  type FolderSlug,
} from "../../ids";
import {
  fileCreated,
  fileMoved,
  fileReplaced,
} from "../../store/domain/change-events";
import {
  type FileFormat,
  formatOfContentType,
  normalizeFileName,
} from "../../store/domain/file-kinds";
import { normalizeSlug } from "../../store/domain/paths";
import type { FileNode } from "../../store/repos/file-repo";
import { MAX_PROJECT_FILE_BYTES } from "../../util";
import type { CommandOutcome, ProjectCommandContext } from "../command";

import { corpusOfFolder } from "./corpus-tree";
import { FilenameCollision } from "./documents";
import { deleteFileCommand, type StoredFileView } from "./files";
import { checkedPathSegments } from "./untrusted-path";

// The corpus-scoped, path-addressed file operations behind the key-authenticated
// REST surface (and so the CLI). A file is addressed by its corpus-relative
// path like a document. Each command re-checks INSIDE the write that the file
// is in the bound corpus now, so a membership snapshot taken earlier in the
// request never widens the scope; a name taken at the destination throws
// `FilenameCollision`, so folders created on the way roll back with it.

export type PutFileAtPathInput = Readonly<{
  corpusSlug: CorpusSlug;
  path: string;
  contentHash: string;
  size: number;
  format: FileFormat;
  // The hash the caller last synced: replace the file only while it is still
  // this. Absent = create, and the path must be free.
  baseHash: string | undefined;
  changedBy: string;
}>;

export type PutFileAtPathResult = Readonly<
  | { ok: true; changed: boolean; created: boolean; file: StoredFileView }
  // The file there is not the one the caller started from; `undefined`
  // means there is no file at the path.
  | { ok: false; reason: "stale"; currentHash: string | undefined }
  // No precondition was given and a different file is already at the path.
  | { ok: false; reason: "exists"; currentHash: string }
  | { ok: false; reason: "corpus-missing" | "quota-exceeded" }
>;

type FileFields = Pick<
  FileNode,
  "slug" | "filename" | "contentHash" | "contentType" | "size"
>;

export async function putFileAtPathCommand(
  ctx: ProjectCommandContext,
  input: PutFileAtPathInput,
): Promise<CommandOutcome<PutFileAtPathResult>> {
  const refuse = (
    result: Extract<PutFileAtPathResult, { ok: false }>,
  ): CommandOutcome<PutFileAtPathResult> => ({ result, changes: [] });
  const segments = checkedPathSegments(input.path);
  const filename = segments.at(-1);
  if (filename === undefined) {
    throw new ValidationError("A path must name a file.");
  }
  const rootSlug = await ctx.u.cols.rootFolderSlug(input.corpusSlug);
  if (rootSlug === undefined) {
    return refuse({ ok: false, reason: "corpus-missing" });
  }
  const dirs = segments.slice(0, -1);
  const folderSlug = await ctx.u.folders.folderAt(rootSlug, dirs);
  const existing =
    folderSlug === undefined
      ? undefined
      : await ctx.u.files.at(folderSlug, filename);
  const view = (file: FileFields): StoredFileView => ({
    slug: file.slug,
    name: file.filename,
    path: input.path,
    corpusSlug: input.corpusSlug,
    contentHash: file.contentHash,
    contentType: file.contentType,
    size: file.size,
  });

  if (existing === undefined) {
    return createAtPath(ctx, input, { filename, dirs, rootSlug, view });
  }
  if (existing.contentHash === input.contentHash) {
    return {
      result: {
        ok: true,
        changed: false,
        created: false,
        file: view(existing),
      },
      changes: [],
    };
  }
  if (input.baseHash === undefined) {
    return refuse({
      ok: false,
      reason: "exists",
      currentHash: existing.contentHash,
    });
  }
  if (existing.contentHash !== input.baseHash) {
    return refuse({
      ok: false,
      reason: "stale",
      currentHash: existing.contentHash,
    });
  }
  const growth = input.size - existing.size;
  if ((await ctx.u.files.liveBytes()) + growth > MAX_PROJECT_FILE_BYTES) {
    return refuse({ ok: false, reason: "quota-exceeded" });
  }
  const next = {
    contentHash: input.contentHash,
    contentType: input.format.contentType,
    size: input.size,
  };
  await ctx.u.files.replaceContent(existing, next);
  return {
    result: {
      ok: true,
      changed: true,
      created: false,
      file: view({ ...existing, ...next }),
    },
    changes: [
      fileReplaced({
        fileSlug: asFileSlug(existing.slug),
        corpusSlug: input.corpusSlug,
        filename,
        previousHash: existing.contentHash,
        ...next,
        changedBy: input.changedBy,
        changedAt: ctx.now,
      }),
    ],
  };
}

async function createAtPath(
  ctx: ProjectCommandContext,
  input: PutFileAtPathInput,
  where: Readonly<{
    filename: string;
    dirs: readonly string[];
    rootSlug: FolderSlug;
    view: (file: FileFields) => StoredFileView;
  }>,
): Promise<CommandOutcome<PutFileAtPathResult>> {
  const refuse = (
    result: Extract<PutFileAtPathResult, { ok: false }>,
  ): CommandOutcome<PutFileAtPathResult> => ({ result, changes: [] });
  // A precondition on a file that is not there: it was deleted upstream.
  if (input.baseHash !== undefined) {
    return refuse({ ok: false, reason: "stale", currentHash: undefined });
  }
  if ((await ctx.u.files.liveBytes()) + input.size > MAX_PROJECT_FILE_BYTES) {
    return refuse({ ok: false, reason: "quota-exceeded" });
  }
  const ensured = await ctx.u.folders.ensureFolderPath(
    where.rootSlug,
    where.dirs,
    ctx.now,
    (name, taken) => asFolderSlug(normalizeSlug(name, taken)),
  );
  if (
    !ensured.ok ||
    (await ctx.u.folders.slotOccupied(ensured.folderSlug, where.filename))
  ) {
    throw new FilenameCollision();
  }
  const node = await ctx.u.files.create(
    {
      slug: asFileSlug(crypto.randomUUID()),
      filename: where.filename,
      contentHash: input.contentHash,
      contentType: input.format.contentType,
      size: input.size,
      createdAt: ctx.now,
    },
    ensured.folderSlug,
  );
  if (node === undefined) {
    return refuse({ ok: false, reason: "corpus-missing" });
  }
  return {
    result: {
      ok: true,
      changed: true,
      created: true,
      file: where.view(node),
    },
    changes: [
      fileCreated({
        fileSlug: asFileSlug(node.slug),
        corpusSlug: input.corpusSlug,
        filename: where.filename,
        contentHash: input.contentHash,
        contentType: input.format.contentType,
        size: input.size,
        changedBy: input.changedBy,
        changedAt: ctx.now,
      }),
    ],
  };
}

// The live file `slug` when it is in `corpusSlug` now, else undefined: a file
// in another corpus answers exactly like one that does not exist.
export async function fileInCorpus(
  ctx: ProjectCommandContext,
  slug: FileSlug,
  corpusSlug: CorpusSlug,
): Promise<FileNode | undefined> {
  const node = await ctx.u.files.find(slug);
  const folderSlug = await ctx.u.files.folderOf(slug);
  if (
    node === undefined ||
    node.deletedAt !== undefined ||
    folderSlug === undefined ||
    (await corpusOfFolder(ctx.u, asFolderSlug(folderSlug))) !== corpusSlug
  ) {
    return undefined;
  }
  return node;
}

export type DeleteFileInCorpusResult = Readonly<
  | { ok: true }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "stale"; currentHash: string }
>;

// Delete a file of the bound corpus. `baseHash` is the hash the caller last
// saw: if the file moved on, the removal is refused rather than discarding
// bytes the caller never saw.
export async function deleteFileInCorpusCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{
    slug: FileSlug;
    corpusSlug: CorpusSlug;
    baseHash: string | undefined;
    changedBy: string;
  }>,
): Promise<CommandOutcome<DeleteFileInCorpusResult>> {
  const node = await fileInCorpus(ctx, input.slug, input.corpusSlug);
  if (node === undefined) {
    return { result: { ok: false, reason: "missing" }, changes: [] };
  }
  if (input.baseHash !== undefined && node.contentHash !== input.baseHash) {
    return {
      result: { ok: false, reason: "stale", currentHash: node.contentHash },
      changes: [],
    };
  }
  return deleteFileCommand(ctx, {
    slug: input.slug,
    changedBy: input.changedBy,
  });
}

export type MoveFileToPathResult = Readonly<
  | { ok: true; changed: boolean }
  | { ok: false; reason: "missing" | "invalid-name" }
>;

// Move or rename a file of the bound corpus to a corpus-relative path. The
// new name must stay a safe name for the same format, so a rename can never
// turn a PNG into a `.pdf`.
export async function moveFileToPathCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{
    slug: FileSlug;
    corpusSlug: CorpusSlug;
    path: string;
    changedBy: string;
  }>,
): Promise<CommandOutcome<MoveFileToPathResult>> {
  const refuse = (
    reason: "missing" | "invalid-name",
  ): CommandOutcome<MoveFileToPathResult> => ({
    result: { ok: false, reason },
    changes: [],
  });
  const node = await fileInCorpus(ctx, input.slug, input.corpusSlug);
  if (node === undefined) return refuse("missing");
  const segments = checkedPathSegments(input.path);
  const filename = segments.at(-1);
  if (filename === undefined) {
    throw new ValidationError("A path must name a file.");
  }
  const format = formatOfContentType(node.contentType);
  const extension = filename.slice(filename.lastIndexOf(".") + 1);
  if (
    normalizeFileName(filename) !== filename ||
    !format?.extensions.includes(extension)
  ) {
    return refuse("invalid-name");
  }
  const rootSlug = await ctx.u.cols.rootFolderSlug(input.corpusSlug);
  if (rootSlug === undefined) return refuse("missing");
  const ensured = await ctx.u.folders.ensureFolderPath(
    rootSlug,
    segments.slice(0, -1),
    ctx.now,
    (name, taken) => asFolderSlug(normalizeSlug(name, taken)),
  );
  if (!ensured.ok) throw new FilenameCollision();
  const placed = await ctx.u.folders.relocateFile(
    input.slug,
    ensured.folderSlug,
    filename,
  );
  if (!placed.ok) {
    if (placed.reason === "segment-collision") throw new FilenameCollision();
    return refuse("missing");
  }
  if (!placed.changed) {
    return { result: { ok: true, changed: false }, changes: [] };
  }
  if (node.filename !== filename) {
    await ctx.u.files.setFilename(node, filename);
  }
  return {
    result: { ok: true, changed: true },
    changes: [
      fileMoved({
        fileSlug: input.slug,
        corpusSlug: input.corpusSlug,
        fromCorpusSlug: input.corpusSlug,
        filename,
        contentHash: node.contentHash,
        changedBy: input.changedBy,
        changedAt: ctx.now,
      }),
    ],
  };
}
