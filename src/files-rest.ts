import { Hono } from "hono";
import { z } from "zod";

import { apiKeyScope } from "./api-scope";
import {
  invalidPath,
  type GrantCapabilities,
  MAX_PATH_LENGTH,
  refuseBelow,
  type RestContext,
} from "./docs-rest";
import {
  assertEntitled,
  fail,
  QUOTA_MESSAGE,
  readCapped,
  REJECTION_STATUS,
} from "./files/http";
import {
  FILES_NOT_ENABLED_MESSAGE,
  objectStoreFor,
} from "./files/object-store-for";
import { asFileSlug } from "./ids";
import {
  FILE_HASH_PATTERN,
  fileResponseHeaders,
  judgeUpload,
} from "./store/domain/file-kinds";
import { fileObjectKey } from "./store/repos/object-store";
import { MAX_FILE_BYTES, sha256Hex } from "./util";

// The images-and-attachments half of the REST surface for the CLI and
// automation, authenticated by an API key and scoped to its bound corpus
// exactly like `docs-rest.ts`: transport only, the key's grant enforced BEFORE
// any DO call, every file outside the corpus answering like one that does not
// exist.
//
//   read — list and download
//   edit — also create, replace, delete and move
//
// A binary cannot be merged or reviewed line by line, so there is no proposal
// path: a `suggest` key is refused every write with "needs edit access".
// Writes address a file by corpus-relative path (`PUT ?path=`) with an
// `If-Match: <sha-256>` precondition, the file's version being its content
// hash; no `If-Match` means "create, and the path must be free".

const STATUS = {
  created: 201,
  badRequest: 400,
  notFound: 404,
  conflict: 409,
  tooLarge: 413,
  preconditionFailed: 412,
  unprocessable: 422,
  badGateway: 502,
} as const;

export const FILES_NOT_ENABLED_CODE = "files_not_enabled";
const BINARY_WRITE_ACTION =
  "write images or attachments; a binary file cannot be proposed for review";

const FILE_GRANT_CAPABILITIES: GrantCapabilities = {
  read: [
    "list images and attachments (GET /api/v1/files)",
    "download one (GET /api/v1/files/:slug)",
  ],
  suggest: [
    "list images and attachments (GET /api/v1/files)",
    "download one (GET /api/v1/files/:slug)",
  ],
  edit: [
    "list images and attachments (GET /api/v1/files)",
    "download one (GET /api/v1/files/:slug)",
    "upload or replace one (PUT /api/v1/files?path=)",
    "delete one (DELETE /api/v1/files/:slug)",
    "move or rename one (POST /api/v1/files/:slug/move)",
  ],
};

const PutQuery = z.object({ path: z.string().min(1).max(MAX_PATH_LENGTH) });
const MoveBody = z.object({ path: z.string().min(1).max(MAX_PATH_LENGTH) });
const IF_MATCH_PATTERN = /^"?([0-9a-f]{64})"?$/;

const notFound = (c: RestContext): Response =>
  c.json({ error: "not found" }, STATUS.notFound);

const notEnabled = (c: RestContext): Response =>
  c.json(
    { error: FILES_NOT_ENABLED_MESSAGE, code: FILES_NOT_ENABLED_CODE },
    STATUS.notFound,
  );

const stale = (c: RestContext, currentHash: string | undefined): Response =>
  c.json(
    { ok: false, conflict: true, currentSha256: currentHash ?? null },
    STATUS.preconditionFailed,
  );

// `undefined` = no precondition; `null` = a header that is not a hash.
function ifMatchOf(c: RestContext): string | null | undefined {
  const header = c.req.header("if-match");
  if (header === undefined) return undefined;
  return IF_MATCH_PATTERN.exec(header.trim())?.[1] ?? null;
}

export const filesRoutes = new Hono<{ Bindings: Env }>()
  .get("/api/v1/files", async (c) => {
    const scope = await apiKeyScope(c);
    if (scope instanceof Response) return scope;
    // Without file storage this deployment carries no images: the same answer
    // as a server that predates the route, which a sync reads as "not carried".
    if (objectStoreFor(c.env) === undefined) return notEnabled(c);
    const files = await scope.store.corpusFiles(scope.ref.corpusSlug);
    return c.json({
      corpus: { projectId: scope.ref.projectId, slug: scope.ref.corpusSlug },
      grant: scope.grant,
      files: files.map((file) => ({
        slug: file.slug,
        path: file.path,
        sha256: file.contentHash,
        size: file.size,
        contentType: file.contentType,
      })),
    });
  })
  .get("/api/v1/files/:slug", async (c) => {
    const scope = await apiKeyScope(c);
    if (scope instanceof Response) return scope;
    const objects = objectStoreFor(c.env);
    if (objects === undefined) return notEnabled(c);
    const file = await scope.store.corpusFile(
      asFileSlug(c.req.param("slug")),
      scope.ref.corpusSlug,
    );
    if (file === undefined || !FILE_HASH_PATTERN.test(file.contentHash)) {
      return notFound(c);
    }
    const object = await objects.get(
      fileObjectKey(scope.ref.projectId, file.contentHash),
    );
    if (object === undefined) {
      console.error("[files] metadata without bytes", file.contentHash);
      return notFound(c);
    }
    // The bytes are checked against the hash the metadata promises before a
    // client ever sees them (a file is at most MAX_FILE_BYTES, so buffering
    // is bounded); the CLI verifies again on its side.
    const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
    if ((await sha256Hex(bytes)) !== file.contentHash) {
      console.error("[files] stored bytes fail their hash", file.contentHash);
      return c.json(
        { error: "the stored bytes failed their integrity check" },
        STATUS.badGateway,
      );
    }
    const headers = fileResponseHeaders({
      hash: file.contentHash,
      contentType: file.contentType,
      filename: file.filename,
      size: file.size,
      fetchDest: null,
    });
    // The URL names the file (it can be replaced), not its bytes: unlike the
    // app's hash-addressed route, nothing here may be cached as immutable.
    headers.set("cache-control", "private, no-cache");
    return new Response(bytes, { headers });
  })
  .put("/api/v1/files", async (c) => {
    const scope = await apiKeyScope(c);
    if (scope instanceof Response) return scope;
    const refused = refuseBelow(
      c,
      scope,
      "edit",
      BINARY_WRITE_ACTION,
      FILE_GRANT_CAPABILITIES,
    );
    if (refused !== undefined) return refused;
    const objects = objectStoreFor(c.env);
    if (objects === undefined) return notEnabled(c);
    const query = PutQuery.safeParse(c.req.query());
    if (!query.success) {
      return c.json({ error: "path is required" }, STATUS.badRequest);
    }
    const { path } = query.data;
    const bad = invalidPath(c, path);
    if (bad !== undefined) return bad;
    const baseHash = ifMatchOf(c);
    if (baseHash === null) {
      return c.json(
        { error: "If-Match must be the file's sha-256" },
        STATUS.badRequest,
      );
    }

    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) {
      return c.json({ error: "the file is too large" }, STATUS.tooLarge);
    }
    const bytes = await readCapped(c.req.raw, MAX_FILE_BYTES);
    if (bytes === undefined) {
      return c.json({ error: "the file is too large" }, STATUS.tooLarge);
    }
    // A path names the file, so its last segment must already be a name the
    // server would keep: silently renaming it would leave the caller tracking
    // a path that does not exist.
    const name = path
      .split("/")
      .filter((s) => s !== "")
      .at(-1);
    const verdict = judgeUpload(bytes, name);
    if (!verdict.ok) {
      return fail(c, verdict.message, REJECTION_STATUS[verdict.reason]);
    }
    if (verdict.name !== name) {
      return c.json(
        {
          error: `The file name "${name ?? ""}" would be stored as "${verdict.name ?? ""}"; rename it first (letters, digits, ".", "_" and "-", with a lowercase extension).`,
        },
        STATUS.unprocessable,
      );
    }
    const quota = await assertEntitled(c, scope.ref, bytes.byteLength);
    if (quota !== undefined) return quota;

    // Bytes first, metadata second: see `store` in `files/http.ts`.
    const contentHash = await sha256Hex(bytes);
    await objects.put(fileObjectKey(scope.ref.projectId, contentHash), bytes);
    const r = await scope.store.putFileAtPath({
      corpusSlug: scope.ref.corpusSlug,
      path,
      contentHash,
      size: bytes.byteLength,
      format: verdict.format,
      baseHash,
      changedBy: scope.ref.userId,
    });
    if (r.ok) {
      return c.json(
        {
          ok: true,
          slug: r.file.slug,
          path: r.file.path,
          sha256: r.file.contentHash,
          size: r.file.size,
          created: r.created,
          changed: r.changed,
        },
        r.created ? STATUS.created : 200,
      );
    }
    switch (r.reason) {
      case "stale":
      case "exists":
        return stale(c, r.currentHash);
      case "segment-collision":
        return c.json({ ok: false, segmentCollision: true }, STATUS.conflict);
      case "quota-exceeded":
        return c.json({ error: QUOTA_MESSAGE }, STATUS.tooLarge);
      case "corpus-missing":
        return notFound(c);
    }
  })
  .delete("/api/v1/files/:slug", async (c) => {
    const scope = await apiKeyScope(c);
    if (scope instanceof Response) return scope;
    const refused = refuseBelow(
      c,
      scope,
      "edit",
      "delete images or attachments; a removal cannot be proposed for review",
      FILE_GRANT_CAPABILITIES,
    );
    if (refused !== undefined) return refused;
    const baseHash = ifMatchOf(c);
    if (baseHash === null) {
      return c.json(
        { error: "If-Match must be the file's sha-256" },
        STATUS.badRequest,
      );
    }
    const r = await scope.store.deleteFileInCorpus(
      asFileSlug(c.req.param("slug")),
      scope.ref.corpusSlug,
      baseHash,
      scope.ref.userId,
    );
    if (r.ok) return c.json({ ok: true });
    return r.reason === "stale" ? stale(c, r.currentHash) : notFound(c);
  })
  .post("/api/v1/files/:slug/move", async (c) => {
    const scope = await apiKeyScope(c);
    if (scope instanceof Response) return scope;
    const refused = refuseBelow(
      c,
      scope,
      "edit",
      "move images or attachments; a move cannot be proposed for review",
      FILE_GRANT_CAPABILITIES,
    );
    if (refused !== undefined) return refused;
    const parsed = MoveBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: "invalid body" }, STATUS.badRequest);
    const bad = invalidPath(c, parsed.data.path);
    if (bad !== undefined) return bad;
    const r = await scope.store.moveFileToPath(
      asFileSlug(c.req.param("slug")),
      scope.ref.corpusSlug,
      parsed.data.path,
      scope.ref.userId,
    );
    if (r.ok) return c.json({ ok: true, changed: r.changed });
    if (r.reason === "segment-collision") {
      return c.json({ ok: false, segmentCollision: true }, STATUS.conflict);
    }
    return r.reason === "invalid-name"
      ? c.json(
          {
            error:
              'The new name must be a plain file name that keeps the file\'s type (letters, digits, ".", "_", "-").',
          },
          STATUS.unprocessable,
        )
      : notFound(c);
  });
