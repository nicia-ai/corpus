import { z } from "zod";

import { CliError } from "./errors.js";
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
