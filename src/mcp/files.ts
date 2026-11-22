import { fileObjectKey } from "../store/repos/object-store";

import type { McpExecutor } from "./executor";
import { documentSlugFromRef, strField } from "./params";
import { ERR, err, imageContent, ok, textContent, toolError } from "./protocol";

// The two file tools: `list_files` and `read_file`. Files are optional (the
// `FILES` R2 binding), images are the only thing an agent can look at, and a
// result a client must hold in memory is capped.

// Raw bytes; base64 inflates by a third, so this is about 6.7 MiB on the wire.
export const MCP_FILE_MAX_BYTES = 5 * 1024 * 1024;

// What an MCP client renders as an image block. SVG (text that can carry
// markup) and PDF are metadata only.
const INLINE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export const FILES_DISABLED_TEXT =
  "files are not enabled on this deployment, so images and attachments cannot be read";

const BASE64_CHUNK = 0x8000;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(at, at + BASE64_CHUNK));
  }
  return btoa(binary);
}

function mebibytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

export async function listFilesTool(
  id: unknown,
  exec: McpExecutor,
): Promise<unknown> {
  return ok(id, textContent(JSON.stringify(await exec.listFiles())));
}

export async function readFileTool(
  id: unknown,
  exec: McpExecutor,
  params: Record<string, unknown>,
): Promise<unknown> {
  const path = strField(params, "path").trim();
  if (path === "") {
    return err(id, ERR.INVALID_PARAMS, "read_file needs a path");
  }
  const objects = exec.objects;
  if (objects === undefined) return ok(id, toolError(FILES_DISABLED_TEXT));

  const rawDocument = strField(params, "document").trim();
  const document =
    rawDocument === ""
      ? undefined
      : await documentSlugFromRef(exec, rawDocument);
  const file = await exec.getFile(
    document === undefined ? { path } : { path, document },
  );
  if (file === undefined) {
    return err(id, ERR.NOT_FOUND, `unknown file: ${path}`);
  }

  if (!INLINE_IMAGE_TYPES.has(file.contentType)) {
    return ok(
      id,
      textContent(
        JSON.stringify({
          name: file.name,
          path: file.path,
          size: file.size,
          contentType: file.contentType,
          note: "this file type is not shown inline; only its metadata is available",
        }),
      ),
    );
  }
  if (file.size > MCP_FILE_MAX_BYTES) {
    return ok(
      id,
      toolError(
        `${file.path} is ${String(file.size)} bytes (${mebibytes(file.size)} MiB); read_file returns files up to ${String(MCP_FILE_MAX_BYTES)} bytes (${mebibytes(MCP_FILE_MAX_BYTES)} MiB)`,
      ),
    );
  }
  const object = await objects.get(
    fileObjectKey(exec.projectId, file.contentHash),
  );
  if (object === undefined) {
    return ok(
      id,
      toolError(`the bytes of ${file.path} are missing from storage`),
    );
  }
  const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
  return ok(id, imageContent(toBase64(bytes), file.contentType));
}
