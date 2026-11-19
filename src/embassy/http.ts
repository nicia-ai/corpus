import type { Context } from "hono";

import { getAuth } from "@/auth.server";
import { connectControlDb, type ControlDb } from "@/control/db";
import {
  noteEmbassyFetch,
  organizationIdForProject,
  releaseEmbassyWrite,
  reserveEmbassyWrite,
  resolveLiveEmbassy,
  type EmbassyView,
} from "@/control/embassies";
import { entitlementsForRequest } from "@/control/entitlements";
import { resolveProjectById } from "@/control/project-resolution";
import { storeFor } from "@/control/store-for";
import { grantAllows, type EmbassyGrant } from "@/embassy/grant";
import { embassyGoneHtml, embassyPageHtml } from "@/embassy/html";
import { embassyPath } from "@/embassy/url";
import { QuotaExceededError } from "@/errors";
import { asEmbassyId, callerRefFromEmbassy } from "@/ids";
import type {
  SaveSharedDraftResult,
  SaveSharedSectionResult,
} from "@/project-store/contracts";
import { parseFrontmatter } from "@/store/domain/frontmatter";
import {
  parseSectionTarget,
  type SectionMatch,
  type SectionTarget,
} from "@/store/domain/sections";
import {
  isBlank,
  MARKDOWN_TOO_LARGE_MESSAGE,
  markdownTooLarge,
  utf8Bytes,
} from "@/util";

type EnvC = Readonly<Context<{ Bindings: Env }>>;

function prefersHtml(accept: string | undefined): boolean {
  if (accept === undefined || accept.trim() === "") return false;
  const parts = accept.split(",").map((p) => p.trim().toLowerCase());
  let htmlQ = -1;
  let mdQ = -1;
  for (const part of parts) {
    const [typeRaw, ...params] = part.split(";").map((x) => x.trim());
    const type = typeRaw ?? "";
    const qParam = params.find((p) => p.startsWith("q="));
    const q = qParam === undefined ? 1 : Number(qParam.slice(2));
    if (Number.isNaN(q)) continue;
    if (type === "text/html" || type === "application/xhtml+xml") {
      htmlQ = Math.max(htmlQ, q);
    }
    if (type === "text/markdown") {
      mdQ = Math.max(mdQ, q);
    }
  }
  if (htmlQ < 0 && mdQ < 0) return false;
  return htmlQ > mdQ;
}

function versionHeader(req: Request): number | undefined {
  const raw = req.headers.get("x-doc-version");
  if (raw === null || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return undefined;
  return n;
}

async function liveEmbassy(
  c: EnvC,
  token: string | undefined,
): Promise<EmbassyView | undefined> {
  if (token === undefined || token === "") return undefined;
  return resolveLiveEmbassy(connectControlDb(c.env.DB), asEmbassyId(token));
}

function notFound(c: EnvC, html: boolean): Response {
  return html
    ? c.html(embassyGoneHtml(), 404, { "referrer-policy": "no-referrer" })
    : c.text("not found", 404);
}

async function maybeRedirectMember(
  c: EnvC,
  row: EmbassyView,
): Promise<Response | undefined> {
  const headers = c.req.raw.headers;
  if (headers.get("cookie") === null && headers.get("authorization") === null) {
    return undefined;
  }
  const session = await getAuth(c.env).api.getSession({ headers });
  if (!session) return undefined;
  const getSession = () => Promise.resolve(session);
  const ref = await resolveProjectById(
    connectControlDb(c.env.DB),
    getSession,
    headers,
    row.projectId,
  );
  if (ref === undefined) return undefined;
  return c.redirect(
    `/p/${encodeURIComponent(row.projectId)}/documents/${encodeURIComponent(row.documentSlug)}`,
    302,
  );
}

type WritePrep =
  | Readonly<{ ok: false; response: Response }>
  | Readonly<{
      ok: true;
      row: EmbassyView;
      clientVersion: number;
      body: string;
      db: ControlDb;
    }>;

// Agents read the 403 body; an edit link the owner switched to review must
// say where the change goes now instead.
function forbidden(
  c: EnvC,
  held: EmbassyGrant,
  needed: EmbassyGrant,
): Response {
  if (needed === "edit" && held === "suggest") {
    return c.text(
      "edit access withdrawn: the owner asked to review changes. POST the full proposed markdown to this URL + /suggest instead.",
      403,
    );
  }
  return c.text("forbidden", 403);
}

async function prepareWrite(c: EnvC, needed: EmbassyGrant): Promise<WritePrep> {
  const row = await liveEmbassy(c, c.req.param("token"));
  if (row === undefined)
    return { ok: false, response: c.text("not found", 404) };
  if (!grantAllows(row.grant, needed))
    return { ok: false, response: forbidden(c, row.grant, needed) };
  const clientVersion = versionHeader(c.req.raw);
  if (clientVersion === undefined) {
    return { ok: false, response: c.text("X-Doc-Version required", 400) };
  }
  const body = await c.req.text();
  if (markdownTooLarge(body)) {
    return { ok: false, response: c.text(MARKDOWN_TOO_LARGE_MESSAGE, 413) };
  }
  return {
    ok: true,
    row,
    clientVersion,
    body,
    db: connectControlDb(c.env.DB),
  };
}

async function claimWrite(
  c: EnvC,
  prep: Extract<WritePrep, { ok: true }>,
  needed: EmbassyGrant,
): Promise<Response | undefined> {
  const reserved = await reserveEmbassyWrite(prep.db, {
    id: prep.row.id,
    needed,
  });
  if (reserved) return undefined;
  const again = await resolveLiveEmbassy(prep.db, prep.row.id);
  if (again === undefined) return c.text("not found", 404);
  if (!grantAllows(again.grant, needed)) {
    return forbidden(c, again.grant, needed);
  }
  return c.text("rate limited", 429);
}

async function releaseClaim(
  prep: Extract<WritePrep, { ok: true }>,
): Promise<void> {
  await releaseEmbassyWrite(prep.db, prep.row.id);
}

export async function embassyGet(c: EnvC): Promise<Response> {
  const html = prefersHtml(c.req.header("accept"));
  const row = await liveEmbassy(c, c.req.param("token"));
  if (row === undefined) return notFound(c, html);
  if (html) {
    const bounced = await maybeRedirectMember(c, row);
    if (bounced !== undefined) return bounced;
  }
  const doc = await storeFor(c.env, row.projectId).getDocument(
    row.documentSlug,
  );
  if (doc === undefined) return notFound(c, html);
  const grant =
    row.grant === "edit" &&
    (await storeFor(c.env, row.projectId).isDocumentServed(row.documentSlug))
      ? "suggest"
      : row.grant;
  void noteEmbassyFetch(
    connectControlDb(c.env.DB),
    row.id,
    row.lastFetchedAt,
  ).catch(() => {
    // Metrics-only; a D1 failure must not surface as an unhandled rejection.
  });
  if (html) {
    return c.html(
      embassyPageHtml({
        title: doc.title,
        markdown: doc.markdown,
        url: new URL(embassyPath(row.id), c.req.url).toString(),
        grant,
        docVersion: doc.docVersion,
      }),
      200,
      {
        "referrer-policy": "no-referrer",
        "x-doc-version": String(doc.docVersion),
      },
    );
  }
  return c.body(doc.markdown, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "x-doc-version": String(doc.docVersion),
    "referrer-policy": "no-referrer",
  });
}

export async function embassySuggest(c: EnvC): Promise<Response> {
  const prep = await prepareWrite(c, "suggest");
  if (!prep.ok) return prep.response;
  const refused = await claimWrite(c, prep, "suggest");
  if (refused !== undefined) return refused;
  try {
    const r = await storeFor(c.env, prep.row.projectId).createSuggestion({
      slug: prep.row.documentSlug,
      proposedMarkdown: prep.body,
      clientVersion: prep.clientVersion,
      createdBy: callerRefFromEmbassy(prep.row.id),
      channel: "cli",
    });
    if (!r.ok) {
      await releaseClaim(prep);
      if (r.reason === "conflict") {
        return c.json(
          { ok: false, conflict: true, currentVersion: r.currentVersion },
          409,
        );
      }
      if (r.reason === "too-large") {
        return c.text(MARKDOWN_TOO_LARGE_MESSAGE, 413);
      }
      if (r.reason === "missing") return c.text("not found", 404);
      return c.json({ ok: false, reason: r.reason }, 400);
    }
    return c.json({ ok: true, suggestionId: r.suggestionId }, 201);
  } catch (err) {
    await releaseClaim(prep);
    throw err;
  }
}

const EDIT_BODY_REQUIRED = "body required";
const SERVED_MESSAGE =
  "This page is now served by a corpus. Propose changes with POST to this URL + /suggest instead.";

export async function embassyEdit(c: EnvC): Promise<Response> {
  const prep = await prepareWrite(c, "edit");
  if (!prep.ok) return prep.response;
  const fm = parseFrontmatter(prep.body);
  if (!fm.ok) {
    return c.text(`invalid YAML frontmatter: ${fm.error}`, 400);
  }
  if (isBlank(fm.body)) return c.text(EDIT_BODY_REQUIRED, 400);
  const denied = await assertEditQuota(c, prep);
  if (denied !== undefined) return denied;
  const refused = await claimWrite(c, prep, "edit");
  if (refused !== undefined) return refused;
  const r = await saveEdit(storeFor(c.env, prep.row.projectId), prep);
  if (!r.ok) {
    await releaseClaim(prep);
    if ("served" in r) {
      return c.text(SERVED_MESSAGE, 403);
    }
    if ("conflict" in r) {
      return c.json(
        { ok: false, conflict: true, currentVersion: r.currentVersion },
        409,
      );
    }
    if ("tooLarge" in r) return c.text(MARKDOWN_TOO_LARGE_MESSAGE, 413);
    return c.json({ ok: false }, 409);
  }
  return c.json({ ok: true, docVersion: r.docVersion }, 200);
}

const SECTION_HEADING_PARAM = "heading";
const SECTION_LEVEL_PARAM = "level";

function ambiguousSectionMessage(
  target: SectionTarget,
  matches: readonly SectionMatch[],
): string {
  const where = matches
    .map((m) => `level ${String(m.level)} at line ${String(m.line)}`)
    .join(", ");
  return `heading "${target.text}" matches ${String(matches.length)} sections (${where}). Add ?${SECTION_LEVEL_PARAM}=N to pick one depth; if they share a depth, rename one of them with PUT to this URL (without /section) first.`;
}

// PUT /s/:token/section?heading=<text>[&level=<1-6>]: replace one section's
// content (the body is the section WITHOUT its heading line), or append the
// section when no such heading exists. Same auth, version header, rate limit,
// quota and DO save path as the whole-page PUT.
export async function embassySection(c: EnvC): Promise<Response> {
  const prep = await prepareWrite(c, "edit");
  if (!prep.ok) return prep.response;
  const parsed = parseSectionTarget({
    heading: c.req.query(SECTION_HEADING_PARAM) ?? "",
    level: c.req.query(SECTION_LEVEL_PARAM),
  });
  if (!parsed.ok) return c.text(parsed.error, 400);
  const denied = await assertEditQuota(c, prep);
  if (denied !== undefined) return denied;
  const refused = await claimWrite(c, prep, "edit");
  if (refused !== undefined) return refused;
  const r = await saveSection(
    storeFor(c.env, prep.row.projectId),
    prep,
    parsed.target,
  );
  if (r.ok) {
    return c.json(
      { ok: true, docVersion: r.docVersion, created: r.created },
      200,
    );
  }
  await releaseClaim(prep);
  if ("served" in r) return c.text(SERVED_MESSAGE, 403);
  if ("missing" in r) return c.text("not found", 404);
  if ("ambiguous" in r) {
    return c.text(ambiguousSectionMessage(parsed.target, r.matches), 422);
  }
  if ("invalidBody" in r) return c.text(r.error, 422);
  if ("conflict" in r) {
    return c.json(
      { ok: false, conflict: true, currentVersion: r.currentVersion },
      409,
    );
  }
  if ("tooLarge" in r) return c.text(MARKDOWN_TOO_LARGE_MESSAGE, 413);
  return c.json({ ok: false }, 409);
}

async function saveSection(
  store: ReturnType<typeof storeFor>,
  prep: Extract<WritePrep, { ok: true }>,
  target: SectionTarget,
): Promise<SaveSharedSectionResult> {
  try {
    return await store.saveSharedSection({
      slug: prep.row.documentSlug,
      target,
      body: prep.body,
      clientVersion: prep.clientVersion,
      changedBy: callerRefFromEmbassy(prep.row.id),
    });
  } catch (err) {
    await releaseClaim(prep);
    throw err;
  }
}

async function saveEdit(
  store: ReturnType<typeof storeFor>,
  prep: Extract<WritePrep, { ok: true }>,
): Promise<SaveSharedDraftResult> {
  try {
    return await store.saveSharedDraft({
      slug: prep.row.documentSlug,
      markdown: prep.body,
      clientVersion: prep.clientVersion,
      changedBy: callerRefFromEmbassy(prep.row.id),
    });
  } catch (err) {
    await releaseClaim(prep);
    throw err;
  }
}

async function assertEditQuota(
  c: EnvC,
  prep: Extract<WritePrep, { ok: true }>,
): Promise<Response | undefined> {
  const organizationId = await organizationIdForProject(
    prep.db,
    prep.row.projectId,
  );
  try {
    await entitlementsForRequest(c.req.raw).assertWithinQuota({
      action: "version_create",
      organizationId,
      projectId: prep.row.projectId,
      amount: 1,
      bytes: utf8Bytes(prep.body),
    });
    return undefined;
  } catch (err) {
    if (err instanceof QuotaExceededError) return c.text(err.message, 403);
    throw err;
  }
}
