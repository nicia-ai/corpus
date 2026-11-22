import { z } from "zod";

import { CliError } from "./errors.js";
import { filePath } from "./files-rest.js";
import { type ApiConfig, request } from "./http.js";

// The write half of the REST client: one function per route, each returning
// what the server decided as data (`WriteOutcome`) so callers can plan around
// a conflict instead of catching it. Only the failures nothing can plan
// around throw: an unreachable server, an unexpected status, and a key whose
// grant does not allow the call (`forbidden`).

const STATUS_CONFLICT = 409;
const STATUS_NOT_FOUND = 404;
const STATUS_TOO_LARGE = 413;
const STATUS_FORBIDDEN = 403;
const STATUS_BAD_REQUEST = 400;
const GRANT_TOO_LOW_CODE = "grant_too_low";

const WriteResponseSchema = z.object({
  ok: z.boolean().optional(),
  docVersion: z.number().optional(),
  slug: z.string().optional(),
  changed: z.boolean().optional(),
  proposed: z.boolean().optional(),
  proposalId: z.number().optional(),
  reviewUrl: z.string().optional(),
  noChange: z.boolean().optional(),
  conflict: z.boolean().optional(),
  currentVersion: z.number().optional(),
  segmentCollision: z.boolean().optional(),
  taken: z.boolean().optional(),
  rolledBack: z.boolean().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
});
type WriteResponse = Readonly<z.infer<typeof WriteResponseSchema>>;

export type ProposalReceipt = Readonly<{
  proposalId: number;
  slug: string;
  reviewUrl: string | undefined;
}>;

export type WriteOutcome = Readonly<
  | { kind: "written"; slug: string | undefined; docVersion: number }
  | { kind: "proposed"; proposal: ProposalReceipt }
  // A proposal identical to the document: nothing to review.
  | { kind: "unchanged" }
  | { kind: "moved"; changed: boolean }
  | { kind: "removed" }
  // The document moved on since the version the caller started from.
  | { kind: "conflict"; currentVersion: number | undefined }
  // The destination name is taken by a document or folder.
  | { kind: "path-taken" }
  | { kind: "rolled-back" }
  // No such document in this corpus.
  | { kind: "gone" }
  // The server refused for a reason particular to this request.
  | { kind: "refused"; status: number; message: string }
>;

async function readResponse(res: Response): Promise<WriteResponse> {
  const parsed = WriteResponseSchema.safeParse(
    await res.json().catch(() => ({})),
  );
  return parsed.success ? parsed.data : {};
}

function interpret(res: Response, body: WriteResponse): WriteOutcome {
  if (res.ok) {
    if (body.proposed === true && body.proposalId !== undefined) {
      return {
        kind: "proposed",
        proposal: {
          proposalId: body.proposalId,
          slug: body.slug ?? "",
          reviewUrl: body.reviewUrl,
        },
      };
    }
    if (body.proposed === false && body.noChange === true) {
      return { kind: "unchanged" };
    }
    if (body.docVersion !== undefined) {
      return { kind: "written", slug: body.slug, docVersion: body.docVersion };
    }
    if (body.changed !== undefined) {
      return { kind: "moved", changed: body.changed };
    }
    if (body.ok === true) return { kind: "removed" };
  }
  if (res.status === STATUS_CONFLICT) {
    if (body.segmentCollision === true || body.taken === true) {
      return { kind: "path-taken" };
    }
    if (body.rolledBack === true) return { kind: "rolled-back" };
    return { kind: "conflict", currentVersion: body.currentVersion };
  }
  if (res.status === STATUS_NOT_FOUND) return { kind: "gone" };
  if (res.status === STATUS_FORBIDDEN && body.code === GRANT_TOO_LOW_CODE) {
    throw new CliError("forbidden", body.error ?? "forbidden", {
      status: res.status,
    });
  }
  if (
    res.status === STATUS_FORBIDDEN ||
    res.status === STATUS_TOO_LARGE ||
    res.status === STATUS_BAD_REQUEST
  ) {
    return {
      kind: "refused",
      status: res.status,
      message: body.error ?? `refused (${String(res.status)})`,
    };
  }
  throw new CliError("http", `request failed (${String(res.status)})`, {
    status: res.status,
  });
}

async function send(
  cfg: ApiConfig,
  path: string,
  method: string,
  body?: unknown,
): Promise<WriteOutcome> {
  const res = await request(cfg, path, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  return interpret(res, await readResponse(res));
}

const docPath = (slug: string): string =>
  `/api/v1/docs/${encodeURIComponent(slug)}`;

// Write (`edit`) or propose (`suggest`) a new version of `slug` started from
// `clientVersion`; version 0 creates it, at `path` when given.
export function putDocument(
  cfg: ApiConfig,
  input: Readonly<{
    slug: string;
    markdown: string;
    clientVersion: number;
    path?: string | undefined;
  }>,
): Promise<WriteOutcome> {
  return send(cfg, docPath(input.slug), "PUT", {
    markdown: input.markdown,
    clientVersion: input.clientVersion,
    ...(input.path === undefined ? {} : { path: input.path }),
  });
}

// Create (`edit`) or propose (`suggest`) a NEW document at a corpus-relative
// path; the server derives the slug.
export function createDocument(
  cfg: ApiConfig,
  input: Readonly<{ markdown: string; path: string }>,
): Promise<WriteOutcome> {
  return send(cfg, "/api/v1/docs", "POST", input);
}

// Archive a document (`edit` only), refused if it moved past `clientVersion`.
export function removeDocument(
  cfg: ApiConfig,
  input: Readonly<{ slug: string; clientVersion: number }>,
): Promise<WriteOutcome> {
  return send(
    cfg,
    `${docPath(input.slug)}?clientVersion=${String(input.clientVersion)}`,
    "DELETE",
  );
}

// Move a document to another path of its corpus, keeping its history
// (`edit` only).
export function moveDocument(
  cfg: ApiConfig,
  input: Readonly<{ slug: string; path: string }>,
): Promise<WriteOutcome> {
  return send(cfg, `${docPath(input.slug)}/move`, "POST", {
    path: input.path,
  });
}

// — Files ———————————————————————————————————————————————————————————
// Images and attachments are written by path with an `If-Match` precondition
// (the sha-256 the caller last synced). They have no proposal path, so a
// `suggest` key is refused (`forbidden`, with the server's explanation).

const STATUS_PRECONDITION_FAILED = 412;
const STATUS_UNSUPPORTED_TYPE = 415;
const STATUS_UNPROCESSABLE = 422;
const FILES_NOT_ENABLED_CODE = "files_not_enabled";

const FileWriteResponseSchema = z.object({
  ok: z.boolean().optional(),
  slug: z.string().optional(),
  sha256: z.string().optional(),
  created: z.boolean().optional(),
  changed: z.boolean().optional(),
  conflict: z.boolean().optional(),
  currentSha256: z.string().nullable().optional(),
  segmentCollision: z.boolean().optional(),
  taken: z.boolean().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
});

export type FileWriteOutcome = Readonly<
  | { kind: "stored"; slug: string; sha256: string; created: boolean }
  | { kind: "moved"; changed: boolean }
  | { kind: "removed" }
  // The file at the path is not the one the caller started from; `undefined`
  // means it is gone.
  | { kind: "conflict"; currentSha256: string | undefined }
  // The destination name is taken by a document, folder or another file.
  | { kind: "path-taken" }
  // No such file in this corpus.
  | { kind: "gone" }
  // A server that predates files: the route does not exist.
  | { kind: "unsupported" }
  | { kind: "refused"; status: number; message: string }
>;

function interpretFileWrite(
  res: Response,
  body: z.infer<typeof FileWriteResponseSchema>,
): FileWriteOutcome {
  if (res.ok) {
    if (body.slug !== undefined && body.sha256 !== undefined) {
      return {
        kind: "stored",
        slug: body.slug,
        sha256: body.sha256,
        created: body.created === true,
      };
    }
    if (body.changed !== undefined) {
      return { kind: "moved", changed: body.changed };
    }
    if (body.ok === true) return { kind: "removed" };
  }
  if (res.status === STATUS_PRECONDITION_FAILED) {
    return { kind: "conflict", currentSha256: body.currentSha256 ?? undefined };
  }
  if (res.status === STATUS_CONFLICT) return { kind: "path-taken" };
  if (res.status === STATUS_NOT_FOUND) {
    // The server's own 404s carry a JSON error; an old server's missing
    // route does not.
    if (body.error === undefined) return { kind: "unsupported" };
    return body.code === FILES_NOT_ENABLED_CODE
      ? { kind: "refused", status: res.status, message: body.error }
      : { kind: "gone" };
  }
  if (res.status === STATUS_FORBIDDEN && body.code === GRANT_TOO_LOW_CODE) {
    throw new CliError("forbidden", body.error ?? "forbidden", {
      status: res.status,
    });
  }
  if (
    res.status === STATUS_FORBIDDEN ||
    res.status === STATUS_TOO_LARGE ||
    res.status === STATUS_BAD_REQUEST ||
    res.status === STATUS_UNSUPPORTED_TYPE ||
    res.status === STATUS_UNPROCESSABLE
  ) {
    return {
      kind: "refused",
      status: res.status,
      message: body.error ?? `refused (${String(res.status)})`,
    };
  }
  throw new CliError("http", `request failed (${String(res.status)})`, {
    status: res.status,
  });
}

async function sendFile(
  cfg: ApiConfig,
  path: string,
  init: RequestInit,
): Promise<FileWriteOutcome> {
  const res = await request(cfg, path, init);
  const parsed = FileWriteResponseSchema.safeParse(
    await res.json().catch(() => ({})),
  );
  return interpretFileWrite(res, parsed.success ? parsed.data : {});
}

const ifMatch = (sha256: string): string => `"${sha256}"`;

// Store `bytes` at a corpus-relative path: replace the file there when it is
// still `baseSha256`, or create it when `baseSha256` is absent and the path
// is free.
export function putFile(
  cfg: ApiConfig,
  input: Readonly<{
    path: string;
    bytes: Uint8Array<ArrayBuffer>;
    baseSha256?: string | undefined;
  }>,
): Promise<FileWriteOutcome> {
  return sendFile(cfg, `/api/v1/files?path=${encodeURIComponent(input.path)}`, {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      ...(input.baseSha256 === undefined
        ? {}
        : { "if-match": ifMatch(input.baseSha256) }),
    },
    body: input.bytes,
  });
}

// Delete a file (`edit` only), refused if it is no longer `baseSha256`.
export function removeFile(
  cfg: ApiConfig,
  input: Readonly<{ slug: string; baseSha256: string }>,
): Promise<FileWriteOutcome> {
  return sendFile(cfg, filePath(input.slug), {
    method: "DELETE",
    headers: { "if-match": ifMatch(input.baseSha256) },
  });
}

// Move or rename a file within its corpus, keeping its slug (`edit` only).
export function moveFile(
  cfg: ApiConfig,
  input: Readonly<{ slug: string; path: string }>,
): Promise<FileWriteOutcome> {
  return sendFile(cfg, `${filePath(input.slug)}/move`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: input.path }),
  });
}
