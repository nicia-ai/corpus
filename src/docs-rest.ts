import { type Context, Hono } from "hono";
import { z } from "zod";

import { type ApiKeyScope, apiKeyScope } from "./api-scope";
import { ValidationError } from "./errors";
import { type Grant, grantAllows } from "./grant";
import { asDocumentSlug } from "./ids";
import {
  MIRROR_NOT_ENABLED_MESSAGE,
  MIRROR_NOT_READY_MESSAGE,
} from "./mirror/errors";
import { checkedPathSegments } from "./project-store/commands/untrusted-path";
import { proposalReviewUrl } from "./proposal-review-url";
import { MIRROR_BRANCH } from "./store/domain/git-mirror";
import { NEW_DOCUMENT_SLUG } from "./store/domain/paths";
import { compact, MARKDOWN_TOO_LARGE_MESSAGE, markdownBodyZ } from "./util";

// The REST surface for the CLI / automation, authenticated by an API key.
// Transport only: Zod at the boundary, the key's grant enforced BEFORE any
// DO call, results mapped to HTTP. Every route is scoped to the key's bound
// Corpus — an agent credential never reads or writes a document outside it
// (Drafts included). A document outside the Corpus answers exactly like one
// that does not exist.
//
// The grant is the same rule a share link carries (`grantAllows`):
//   read    — list and fetch
//   suggest — also submit changes, which become proposals a person reviews
//   edit    — also write directly, create, move and archive

type RestContext = Readonly<Context<{ Bindings: Env }>>;

const MAX_PATH_LENGTH = 1_024;
const STATUS_ACCEPTED = 202;
const STATUS_CREATED = 201;

export const GRANT_TOO_LOW_CODE = "grant_too_low";

// What each grant can do over this surface, in the words a 403 uses to tell
// a client what it may do instead.
const GRANT_CAPABILITIES: Readonly<Record<Grant, readonly string[]>> = {
  read: [
    "list documents (GET /api/v1/docs)",
    "fetch one (GET /api/v1/docs/:slug)",
  ],
  suggest: [
    "list documents (GET /api/v1/docs)",
    "fetch one (GET /api/v1/docs/:slug)",
    "propose an edit to a document (PUT /api/v1/docs/:slug)",
    "propose a new document (POST /api/v1/docs)",
  ],
  edit: [
    "list documents (GET /api/v1/docs)",
    "fetch one (GET /api/v1/docs/:slug)",
    "write documents directly (PUT /api/v1/docs/:slug)",
    "create documents (POST /api/v1/docs)",
    "move documents (POST /api/v1/docs/:slug/move)",
    "archive documents (DELETE /api/v1/docs/:slug)",
  ],
};

function refuseBelow(
  c: RestContext,
  scope: ApiKeyScope,
  needed: Grant,
  action: string,
): Response | undefined {
  if (grantAllows(scope.grant, needed)) return undefined;
  const allowed = GRANT_CAPABILITIES[scope.grant];
  return c.json(
    {
      error:
        `This key has ${scope.grant} access, so it cannot ${action}; that needs ${needed} access. ` +
        `With ${scope.grant} access it can: ${allowed.join("; ")}. ` +
        "An organization owner can change the key's access.",
      code: GRANT_TOO_LOW_CODE,
      grant: scope.grant,
      needed,
      allowed,
    },
    403,
  );
}

const PathZ = z.string().min(1).max(MAX_PATH_LENGTH);

const DocPushBody = z.object({
  // First-gate length cap; the DO's UTF-8 byte check is the authority
  // (multi-byte text can pass this and still come back `tooLarge`).
  markdown: markdownBodyZ,
  clientVersion: z.number().int().nonnegative(),
  title: z.string().optional(),
  // Where a NEW document goes, relative to the key's corpus (missing folders
  // are created). Absent = the corpus top level. Ignored for a document that
  // already exists; checked with `checkedPathSegments` before the write.
  path: PathZ.optional(),
});

const DocCreateBody = z.object({
  markdown: markdownBodyZ,
  title: z.string().optional(),
  // Names the file and its folders; the server derives the slug from it.
  path: PathZ,
});

const DocMoveBody = z.object({ path: PathZ });

const DocRemoveQuery = z.object({
  // The version the caller last saw: a removal never discards an edit it
  // has not seen.
  clientVersion: z.coerce.number().int().positive(),
});

// True when the body failed ONLY because the markdown blew the length gate —
// classified on Zod's structured issue code (never a message match) so the
// caller gets a 413 naming the limit rather than a generic "invalid body".
function markdownTooBig(error: z.ZodError): boolean {
  return error.issues.some(
    (issue) => issue.code === "too_big" && issue.path[0] === "markdown",
  );
}

function badBody(c: RestContext, error: z.ZodError): Response {
  return markdownTooBig(error)
    ? c.json({ error: MARKDOWN_TOO_LARGE_MESSAGE }, 413)
    : c.json({ error: "invalid body" }, 400);
}

// The server-side path validation every transport shares: no `..`, absolute
// paths, backslashes or control characters.
function invalidPath(c: RestContext, path: string): Response | undefined {
  try {
    checkedPathSegments(path);
    return undefined;
  } catch (error) {
    if (error instanceof ValidationError) {
      return c.json({ error: error.message }, 400);
    }
    throw error;
  }
}

async function readBody<T extends z.ZodType>(
  c: RestContext,
  schema: T,
): Promise<z.ZodSafeParseResult<z.output<T>>> {
  return schema.safeParse(await c.req.json().catch(() => null));
}

function proposed(
  c: RestContext,
  scope: ApiKeyScope,
  proposal: Readonly<{
    proposalId: number;
    kind: "edit" | "create";
    slug: string;
  }>,
): Response {
  return c.json(
    {
      ok: true,
      proposed: true,
      proposalId: proposal.proposalId,
      kind: proposal.kind,
      slug: proposal.slug,
      reviewUrl: proposalReviewUrl(
        { baseUrl: c.env.BETTER_AUTH_URL, projectId: scope.ref.projectId },
        {
          proposalId: proposal.proposalId,
          kind: proposal.kind,
          documentSlug: proposal.slug,
          outcome: "open",
        },
      ),
    },
    STATUS_ACCEPTED,
  );
}

type FailedWrite = Readonly<
  | { forbidden: true }
  | { tooLarge: true }
  | { conflict: true; currentVersion: number }
  | { segmentCollision: true }
  | { unknownLocation: true }
  | { rolledBack: true }
>;

// A direct write the DO refused, as HTTP. `updating` = the caller named a
// version above 0, so a refusal that would reveal another scope's document
// answers "not found" instead.
function failedWrite(
  c: RestContext,
  r: FailedWrite,
  updating: boolean,
): Response {
  if ("forbidden" in r || "unknownLocation" in r) {
    return updating
      ? c.json({ error: "not found" }, 404)
      : c.json({ error: "forbidden" }, 403);
  }
  if ("tooLarge" in r)
    return c.json({ error: MARKDOWN_TOO_LARGE_MESSAGE }, 413);
  if ("conflict" in r) {
    // Head version 0 = there is no such document: an update of a slug that
    // does not exist reads exactly like an update of one outside the corpus.
    if (r.currentVersion === 0) return c.json({ error: "not found" }, 404);
    return c.json(
      { ok: false, conflict: true, currentVersion: r.currentVersion },
      409,
    );
  }
  if ("segmentCollision" in r) {
    return c.json({ ok: false, segmentCollision: true }, 409);
  }
  return c.json({ ok: false, rolledBack: true }, 409);
}

type PushBody = Readonly<z.output<typeof DocPushBody>>;

// `edit`: write canonical content directly. `members` is a snapshot from the
// start of the request, so the write never trusts it: the DO decides inside
// its transaction, against where the document is NOW. A document in the bound
// corpus is updated; a wholly-new slug is created in the corpus (at `path`
// when given); a slug that exists outside it is `forbidden`.
async function writeDirectly(
  c: RestContext,
  scope: ApiKeyScope,
  slug: string,
  body: PushBody,
): Promise<Response> {
  const r = await scope.store.saveDocumentInCorpus(
    compact({
      slug: asDocumentSlug(slug),
      markdown: body.markdown,
      title: body.title,
      clientVersion: body.clientVersion,
      changedBy: scope.ref.userId,
    }),
    scope.ref.corpusSlug,
    body.path,
  );
  if (r.ok) return c.json({ ok: true, docVersion: r.docVersion });
  return failedWrite(c, r, body.clientVersion > 0);
}

// `suggest`: the same write becomes a proposal. A version above 0 proposes an
// edit to the document at that version; version 0 proposes a NEW document at
// `slug` (and `path`). Nothing canonical changes until a person applies it.
async function proposeWrite(
  c: RestContext,
  scope: ApiKeyScope,
  slug: string,
  body: PushBody,
): Promise<Response> {
  if (body.clientVersion === 0) return proposeNew(c, scope, body, slug);
  if (!scope.members.has(slug)) return c.json({ error: "not found" }, 404);
  const r = await scope.store.createSuggestion({
    slug: asDocumentSlug(slug),
    proposedMarkdown: body.markdown,
    clientVersion: body.clientVersion,
    createdBy: scope.callerRef,
    channel: "cli",
    inCorpus: scope.ref.corpusSlug,
  });
  if (r.ok) {
    return proposed(c, scope, {
      proposalId: r.suggestionId,
      kind: "edit",
      slug,
    });
  }
  if (r.reason === "conflict") {
    return c.json(
      { ok: false, conflict: true, currentVersion: r.currentVersion },
      409,
    );
  }
  if (r.reason === "too-large") {
    return c.json({ error: MARKDOWN_TOO_LARGE_MESSAGE }, 413);
  }
  if (r.reason === "no-change") {
    return c.json({ ok: true, proposed: false, noChange: true });
  }
  return c.json({ error: "not found" }, 404);
}

async function proposeNew(
  c: RestContext,
  scope: ApiKeyScope,
  body: Readonly<{ markdown: string; path?: string | undefined }>,
  slug?: string,
): Promise<Response> {
  if (slug !== undefined && !NEW_DOCUMENT_SLUG.test(slug)) {
    return c.json(
      {
        error:
          "not a valid new document slug (lowercase letters, digits, single dashes)",
      },
      400,
    );
  }
  const r = await scope.store.createDocProposal(
    compact({
      slug: slug === undefined ? undefined : asDocumentSlug(slug),
      path: body.path,
      proposedMarkdown: body.markdown,
      createdBy: scope.callerRef,
      channel: "cli" as const,
      originCollectionSlug: scope.ref.corpusSlug,
    }),
  );
  if (r.ok) {
    return proposed(c, scope, {
      proposalId: r.suggestionId,
      kind: "create",
      slug: r.slug,
    });
  }
  if (r.reason === "taken") {
    return c.json({ ok: false, conflict: true, taken: true }, 409);
  }
  if (r.reason === "too-large") {
    return c.json({ error: MARKDOWN_TOO_LARGE_MESSAGE }, 413);
  }
  return c.json({ error: "invalid body" }, 400);
}

export const docsRoutes = new Hono<{ Bindings: Env }>()
  .get("/api/v1/docs", async (c) => {
    const scope = await apiKeyScope(c);
    if (scope instanceof Response) return scope;
    const docs = await scope.store.listDocuments();
    return c.json({
      corpus: { projectId: scope.ref.projectId, slug: scope.ref.corpusSlug },
      grant: scope.grant,
      documents: docs
        .filter((d) => scope.members.has(d.slug))
        .map((d) => ({
          slug: d.slug,
          title: d.title,
          docVersion: d.docVersion,
          path: d.path,
        })),
    });
  })
  .get("/api/v1/docs/:slug", async (c) => {
    const scope = await apiKeyScope(c);
    if (scope instanceof Response) return scope;
    const slug = c.req.param("slug");
    if (!scope.members.has(slug)) return c.json({ error: "not found" }, 404);
    const d = await scope.store.getDocument(asDocumentSlug(slug));
    if (d === undefined) return c.json({ error: "not found" }, 404);
    return c.json({
      slug: d.slug,
      title: d.title,
      filename: d.filename,
      markdown: d.markdown,
      docVersion: d.docVersion,
    });
  })
  .put("/api/v1/docs/:slug", async (c) => {
    const scope = await apiKeyScope(c);
    if (scope instanceof Response) return scope;
    const refused = refuseBelow(c, scope, "suggest", "submit changes");
    if (refused !== undefined) return refused;
    const parsed = await readBody(c, DocPushBody);
    if (!parsed.success) return badBody(c, parsed.error);
    if (parsed.data.path !== undefined) {
      const bad = invalidPath(c, parsed.data.path);
      if (bad !== undefined) return bad;
    }
    const slug = c.req.param("slug");
    return grantAllows(scope.grant, "edit")
      ? writeDirectly(c, scope, slug, parsed.data)
      : proposeWrite(c, scope, slug, parsed.data);
  })
  .post("/api/v1/docs", async (c) => {
    const scope = await apiKeyScope(c);
    if (scope instanceof Response) return scope;
    const refused = refuseBelow(c, scope, "suggest", "create documents");
    if (refused !== undefined) return refused;
    const parsed = await readBody(c, DocCreateBody);
    if (!parsed.success) return badBody(c, parsed.error);
    const bad = invalidPath(c, parsed.data.path);
    if (bad !== undefined) return bad;
    if (!grantAllows(scope.grant, "edit")) {
      return proposeNew(c, scope, parsed.data);
    }
    const r = await scope.store.createDocumentAtPath(
      compact({
        markdown: parsed.data.markdown,
        title: parsed.data.title,
        changedBy: scope.ref.userId,
      }),
      scope.ref.corpusSlug,
      parsed.data.path,
    );
    if (r.ok) {
      return c.json(
        { ok: true, slug: r.slug, docVersion: r.docVersion },
        STATUS_CREATED,
      );
    }
    return failedWrite(c, r, false);
  })
  .delete("/api/v1/docs/:slug", async (c) => {
    const scope = await apiKeyScope(c);
    if (scope instanceof Response) return scope;
    const refused = refuseBelow(
      c,
      scope,
      "edit",
      scope.grant === "suggest"
        ? "remove documents; a removal cannot be proposed for review"
        : "remove documents",
    );
    if (refused !== undefined) return refused;
    const query = DocRemoveQuery.safeParse(c.req.query());
    if (!query.success) return c.json({ error: "invalid query" }, 400);
    const r = await scope.store.archiveDocumentInCorpus(
      asDocumentSlug(c.req.param("slug")),
      scope.ref.corpusSlug,
      query.data.clientVersion,
      scope.ref.userId,
    );
    if (r.ok) return c.json({ ok: true });
    if ("conflict" in r) {
      return c.json(
        { ok: false, conflict: true, currentVersion: r.currentVersion },
        409,
      );
    }
    return c.json({ error: "not found" }, 404);
  })
  .post("/api/v1/docs/:slug/move", async (c) => {
    const scope = await apiKeyScope(c);
    if (scope instanceof Response) return scope;
    const refused = refuseBelow(
      c,
      scope,
      "edit",
      scope.grant === "suggest"
        ? "move documents; a move cannot be proposed for review"
        : "move documents",
    );
    if (refused !== undefined) return refused;
    const parsed = await readBody(c, DocMoveBody);
    if (!parsed.success) return c.json({ error: "invalid body" }, 400);
    const bad = invalidPath(c, parsed.data.path);
    if (bad !== undefined) return bad;
    const r = await scope.store.moveDocumentToPath(
      asDocumentSlug(c.req.param("slug")),
      scope.ref.corpusSlug,
      parsed.data.path,
      scope.ref.userId,
    );
    if (r.ok) return c.json({ ok: true, changed: r.changed });
    if ("segmentCollision" in r) {
      return c.json({ ok: false, segmentCollision: true }, 409);
    }
    return c.json({ error: "not found" }, 404);
  })

  // A short-lived READ-ONLY credential for cloning the key's corpus from its
  // mirror repository: cloning is reading, so any grant passes. The API key
  // is exchanged for an Artifacts token scoped to that one repository; a
  // write token is never issued.
  .post("/api/v1/git/token", async (c) => {
    const scope = await apiKeyScope(c);
    if (scope instanceof Response) return scope;
    const refused = refuseBelow(c, scope, "read", "clone the Git mirror");
    if (refused !== undefined) return refused;
    const access = await scope.store.gitCloneAccess(scope.ref.corpusSlug);
    if (access.ok) {
      return c.json({
        remote: access.remote,
        corpus: scope.ref.corpusSlug,
        branch: MIRROR_BRANCH,
        token: access.token,
        expiresAt: access.expiresAt,
        current: access.current,
      });
    }
    if (access.reason === "not-ready") {
      return c.json({ error: MIRROR_NOT_READY_MESSAGE }, 409);
    }
    return c.json(
      {
        error:
          access.reason === "not-enabled"
            ? MIRROR_NOT_ENABLED_MESSAGE
            : "not found",
      },
      404,
    );
  });
