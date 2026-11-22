import type { Context } from "hono";
import { z } from "zod";

import { getAuth } from "@/auth.server";
import { connectControlDb } from "@/control/db";
import { entitlementsForRequest } from "@/control/entitlements";
import { resolveProjectById } from "@/control/project-resolution";
import type { ProjectRef } from "@/control/refs";
import { storeFor } from "@/control/store-for";
import { QuotaExceededError } from "@/errors";
import { asDocumentSlug, asProjectId } from "@/ids";
import { isSameOriginRequest } from "@/lib/same-origin";
import {
  FILE_HASH_PATTERN,
  type FileRejectionReason,
  fileResponseHeaders,
  judgeUpload,
} from "@/store/domain/file-kinds";
import { fileObjectKey, type ObjectStore } from "@/store/repos/object-store";
import { MAX_FILE_BYTES, sha256Hex } from "@/util";

import { FILES_NOT_ENABLED_MESSAGE, objectStoreFor } from "./object-store-for";

// The two file routes (mounted in `src/api.ts`), both authenticated by the web
// session and scoped to one project the session belongs to:
//
//   PUT /api/files?project=<id>&document=<slug>[&name=<file name>]
//       raw bytes in, the stored file out. Lands next to the page.
//   GET /api/files/:projectId/:hash
//       the bytes, behind the project-membership check.
//
// Hono routes are not covered by the CSRF middleware `src/start.tsx` adds to
// server functions, so the upload checks same-origin itself; a GET moves no
// state and needs no such check (the response's CORP header keeps another
// origin from embedding it).

type FilesContext = Readonly<Context<{ Bindings: Env }>>;

const STATUS = {
  created: 201,
  ok: 200,
  notModified: 304,
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  tooLarge: 413,
  unsupported: 415,
  unprocessable: 422,
} as const;

const REJECTION_STATUS: Readonly<Record<FileRejectionReason, number>> = {
  empty: STATUS.badRequest,
  "too-large": STATUS.tooLarge,
  "unsupported-type": STATUS.unsupported,
  "extension-mismatch": STATUS.unprocessable,
  "unsafe-svg": STATUS.unprocessable,
  "invalid-name": STATUS.unprocessable,
};

const QUOTA_MESSAGE = "This project's file storage is full.";

const UploadQuery = z.object({
  project: z.string().min(1),
  document: z.string().min(1),
  name: z.string().optional(),
});

const fail = (c: FilesContext, message: string, status: number): Response =>
  c.json({ error: message }, status as 400);

// The project the session belongs to, or the refusal to send.
async function authorize(
  c: FilesContext,
  projectId: string,
): Promise<Readonly<{ ref: ProjectRef }> | Response> {
  const getSession = () =>
    getAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  if ((await getSession()) === null) {
    return fail(c, "sign in to continue", STATUS.unauthorized);
  }
  const ref = await resolveProjectById(
    connectControlDb(c.env.DB),
    getSession,
    c.req.raw.headers,
    projectId,
  );
  return ref === undefined
    ? fail(c, "no access to this project", STATUS.forbidden)
    : { ref };
}

// The request body, or undefined once it passes `max` bytes. Counting as it
// reads, so a body with no (or a lying) Content-Length cannot buffer past the
// cap.
async function readCapped(
  request: Request,
  max: number,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const reader = request.body?.getReader();
  if (reader === undefined) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

async function assertEntitled(
  c: FilesContext,
  ref: ProjectRef,
  bytes: number,
): Promise<Response | undefined> {
  try {
    await entitlementsForRequest(c.req.raw).assertWithinQuota({
      action: "file_upload",
      organizationId: ref.organizationId,
      projectId: ref.projectId,
      userId: ref.userId,
      bytes,
    });
    return undefined;
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      return fail(c, error.message, STATUS.forbidden);
    }
    throw error;
  }
}

export async function uploadFile(c: FilesContext): Promise<Response> {
  if (!isSameOriginRequest(c.req.raw)) {
    return fail(c, "cross-origin upload refused", STATUS.forbidden);
  }
  const objects = objectStoreFor(c.env);
  if (objects === undefined) {
    return fail(c, FILES_NOT_ENABLED_MESSAGE, STATUS.notFound);
  }
  const query = UploadQuery.safeParse(c.req.query());
  if (!query.success) {
    return fail(c, "project and document are required", STATUS.badRequest);
  }
  const authorized = await authorize(c, query.data.project);
  if (authorized instanceof Response) return authorized;
  const { ref } = authorized;

  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) {
    return fail(c, "the file is too large", STATUS.tooLarge);
  }
  const bytes = await readCapped(c.req.raw, MAX_FILE_BYTES);
  if (bytes === undefined) {
    return fail(c, "the file is too large", STATUS.tooLarge);
  }
  const verdict = judgeUpload(bytes, query.data.name);
  if (!verdict.ok) {
    return fail(c, verdict.message, REJECTION_STATUS[verdict.reason]);
  }
  const refused = await assertEntitled(c, ref, bytes.byteLength);
  if (refused !== undefined) return refused;

  return store(c, objects, ref, {
    bytes,
    verdict,
    document: query.data.document,
  });
}

// Bytes first, metadata second, never the reverse: metadata without bytes is
// a file a person can see and cannot open, while bytes without metadata are an
// orphan the sweep reclaims (`src/files/orphan-sweep.ts`). The object is
// ALWAYS put, even when its key already exists, so `uploaded` marks this
// attempt and the sweep's grace window runs from it.
async function store(
  c: FilesContext,
  objects: ObjectStore,
  ref: ProjectRef,
  upload: Readonly<{
    bytes: Uint8Array<ArrayBuffer>;
    verdict: Extract<ReturnType<typeof judgeUpload>, { ok: true }>;
    document: string;
  }>,
): Promise<Response> {
  const contentHash = await sha256Hex(upload.bytes);
  await objects.put(fileObjectKey(ref.projectId, contentHash), upload.bytes);
  const result = await storeFor(c.env, ref.projectId).attachFile({
    documentSlug: asDocumentSlug(upload.document),
    name: upload.verdict.name,
    contentHash,
    size: upload.bytes.byteLength,
    format: upload.verdict.format,
    changedBy: ref.userId,
  });
  if (!result.ok) {
    return result.reason === "quota-exceeded"
      ? fail(c, QUOTA_MESSAGE, STATUS.tooLarge)
      : fail(c, "that document no longer exists", STATUS.notFound);
  }
  const { file } = result;
  return c.json(
    {
      name: file.name,
      path: file.path,
      url: `/api/files/${ref.projectId}/${file.contentHash}`,
      contentType: file.contentType,
      size: file.size,
      created: result.created,
    },
    result.created ? STATUS.created : STATUS.ok,
  );
}

export async function serveFile(c: FilesContext): Promise<Response> {
  const objects = objectStoreFor(c.env);
  if (objects === undefined) {
    return fail(c, FILES_NOT_ENABLED_MESSAGE, STATUS.notFound);
  }
  const projectId = c.req.param("projectId") ?? "";
  const hash = c.req.param("hash") ?? "";
  const authorized = await authorize(c, projectId);
  if (authorized instanceof Response) return authorized;
  if (!FILE_HASH_PATTERN.test(hash)) {
    return fail(c, "not found", STATUS.notFound);
  }
  // The metadata is the authority: the project must hold a live file with
  // these bytes. A hash another project holds is a 404 here, because the key
  // is built from THIS project's id and the lookup is in THIS project's DO.
  const file = await storeFor(c.env, asProjectId(projectId)).fileByHash(hash);
  if (file === undefined) return fail(c, "not found", STATUS.notFound);

  const headers = fileResponseHeaders({
    hash,
    contentType: file.contentType,
    filename: file.filename,
    size: file.size,
    fetchDest: c.req.header("sec-fetch-dest") ?? null,
  });
  if (c.req.header("if-none-match") === `"${hash}"`) {
    headers.delete("content-length");
    return new Response(null, { status: STATUS.notModified, headers });
  }
  const object = await objects.get(fileObjectKey(asProjectId(projectId), hash));
  if (object === undefined) {
    console.error("[files] metadata without bytes", projectId, hash);
    return fail(c, "not found", STATUS.notFound);
  }
  return new Response(object.body, { status: STATUS.ok, headers });
}
