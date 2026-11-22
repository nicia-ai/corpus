import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  asCorpusSlug,
  asFileSlug,
  asFolderSlug,
  type CorpusSlug,
  type FileSlug,
  type FolderSlug,
} from "@/ids";
import { projectMiddleware } from "@/lib/middleware";
import { changedBy, storeOf } from "@/lib/server/shared";
import { assertServerContext as srv } from "@/lib/server-context";
import type { DeleteFileResult } from "@/project-store/commands/files";
import type { CorpusLocation } from "@/store/domain/corpus-drive";
import { fileUrl } from "@/store/domain/file-kinds";
import type { PlaceFileResult } from "@/store/repos/folder-repo";

// A stored file as the corpus tree shows it. Plain JSON: DO returns carry
// branding, so the handler maps to this explicitly. `url` is what opens it
// (a download for a PDF or SVG, inline for an image).
export type FileRow = Readonly<{
  slug: FileSlug;
  name: string;
  path: string;
  corpusSlug: CorpusSlug;
  // Null = directly in the corpus root.
  folderSlug: FolderSlug | null;
  contentType: string;
  size: number;
  url: string;
}>;

export type { DeleteFileResult, PlaceFileResult };

const slugInput = z.string().min(1);
const locationInput = z
  .object({ corpusSlug: slugInput, folderSlug: slugInput.nullish() })
  .transform((v): CorpusLocation => ({
    corpusSlug: asCorpusSlug(v.corpusSlug),
    folderSlug: v.folderSlug == null ? null : asFolderSlug(v.folderSlug),
  }));

export const getFileList = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .handler(async ({ context }): Promise<readonly FileRow[]> => {
    const c = srv(context);
    const projectId = c.project?.projectId ?? "";
    return (await storeOf(c).listFiles()).map((f) => ({
      slug: asFileSlug(f.slug),
      name: f.name,
      path: f.path,
      corpusSlug: f.corpusSlug,
      folderSlug: f.folderSlug === null ? null : asFolderSlug(f.folderSlug),
      contentType: f.contentType,
      size: f.size,
      url: fileUrl(projectId, f.contentHash),
    }));
  });

// Soft delete: the file leaves the tree and frees its name; the bytes are
// reclaimed later by the sweep.
export const deleteFile = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(z.object({ slug: slugInput }))
  .handler(async ({ data, context }): Promise<DeleteFileResult> => {
    const c = srv(context);
    return storeOf(c).deleteFile(asFileSlug(data.slug), changedBy(c));
  });

export const moveFile = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(z.object({ slug: slugInput, destination: locationInput }))
  .handler(async ({ data, context }): Promise<PlaceFileResult> => {
    const c = srv(context);
    return storeOf(c).moveFile(
      asFileSlug(data.slug),
      data.destination,
      changedBy(c),
    );
  });
