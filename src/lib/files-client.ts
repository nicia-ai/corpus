import { z } from "zod";

import type { AssetRef } from "@/store/domain/file-kinds";

// The browser half of an upload: raw bytes to `PUT /api/files` (see
// `src/files/http.ts`), cookie-authenticated and same-origin. Not a server
// function: a server function is awkward for binary, and the upload route
// owns its own size cap and type sniffing.

const UploadedFileZ = z.object({
  name: z.string(),
  url: z.string(),
  contentType: z.string(),
  size: z.number(),
});

const ErrorBodyZ = z.object({ error: z.string() });

const FALLBACK_ERROR = "The file could not be uploaded. Try again.";

// A failure with a message fit for a person: the server's own refusal
// ("This SVG contains a script element, so it was not added.") when it sent
// one.
export class FileUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileUploadError";
  }
}

export async function uploadFile(
  args: Readonly<{
    projectId: string;
    documentSlug: string;
    file: File;
    // Omit for a nameless upload (a pasted screenshot): the server names it.
    name: string | undefined;
  }>,
): Promise<AssetRef> {
  const query = new URLSearchParams({
    project: args.projectId,
    document: args.documentSlug,
  });
  if (args.name !== undefined) query.set("name", args.name);
  let response: Response;
  try {
    response = await fetch(`/api/files?${query.toString()}`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/octet-stream" },
      body: args.file,
    });
  } catch {
    throw new FileUploadError(FALLBACK_ERROR);
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = ErrorBodyZ.safeParse(body);
    throw new FileUploadError(
      error.success ? error.data.error : FALLBACK_ERROR,
    );
  }
  const uploaded = UploadedFileZ.safeParse(body);
  if (!uploaded.success) throw new FileUploadError(FALLBACK_ERROR);
  return uploaded.data;
}
