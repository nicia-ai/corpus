import { z } from "zod";

import { CliError } from "./errors.js";
import { type ApiConfig, request } from "./http.js";
import { sha256HexOfBytes } from "./sync-state.js";

// The read half of the files REST surface (`/api/v1/files`): the listing a
// whole-corpus sync plans against and the verified download of one file's
// bytes. Writes live in `rest-write.ts` beside the document writes.

const STATUS_NOT_FOUND = 404;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const RemoteFileSchema = z.object({
  slug: z.string().min(1),
  path: z.string().min(1),
  sha256: z.string().regex(SHA256_HEX),
  size: z.number().int().nonnegative(),
  contentType: z.string(),
});
const FileListSchema = z.object({ files: z.array(RemoteFileSchema) });

export type RemoteFile = Readonly<z.infer<typeof RemoteFileSchema>>;

export const filePath = (slug: string): string =>
  `/api/v1/files/${encodeURIComponent(slug)}`;

// The key's corpus's files, or `undefined` when the server predates files (it
// answers the unknown route 404). That is "this server cannot carry images",
// which a sync must tell apart from "this corpus has none": a corpus with
// none lists `[]`, and treating an old server's 404 as `[]` would read every
// tracked image as removed upstream.
export async function listRemoteFiles(
  cfg: ApiConfig,
): Promise<readonly RemoteFile[] | undefined> {
  const res = await request(cfg, "/api/v1/files");
  if (res.status === STATUS_NOT_FOUND) return undefined;
  if (!res.ok) {
    throw new CliError("http", `file list failed (${String(res.status)})`, {
      status: res.status,
    });
  }
  return FileListSchema.parse(await res.json()).files;
}

// The bytes of one file, verified against the hash the listing promised: a
// body that does not hash to it is never handed back.
export async function downloadFile(
  cfg: ApiConfig,
  file: Pick<RemoteFile, "slug" | "path" | "sha256">,
): Promise<Uint8Array<ArrayBuffer>> {
  const res = await request(cfg, filePath(file.slug));
  if (res.status === STATUS_NOT_FOUND) {
    throw new CliError("not-found", `not found: ${file.path}`, {
      status: res.status,
    });
  }
  if (!res.ok) {
    throw new CliError(
      "http",
      `download of ${file.path} failed (${String(res.status)})`,
      { status: res.status },
    );
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if ((await sha256HexOfBytes(bytes)) !== file.sha256) {
    throw new CliError(
      "mismatch",
      `${file.path} did not download intact (its bytes do not match the hash Corpus listed); nothing was written. Try again.`,
    );
  }
  return bytes;
}
