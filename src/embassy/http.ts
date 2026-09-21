import type { Context } from "hono";

import { getAuth } from "@/auth.server";
import { connectControlDb, type ControlDb } from "@/control/db";
import {
  noteEmbassyFetch,
  organizationIdForProject,
  releaseEmbassyWrite,
  reserveEmbassyWrite,
  resolveLiveEmbassy,
  spendEmbassyReplace,
  type EmbassyView,
} from "@/control/embassies";
import { entitlementsForRequest } from "@/control/entitlements";
import { resolveProjectById } from "@/control/project-resolution";
import { storeFor } from "@/control/store-for";
import { embassyGoneHtml, embassyPageHtml } from "@/embassy/html";
import { isIntakeMarkdown } from "@/embassy/intake";
import { embassyPath } from "@/embassy/url";
import { QuotaExceededError } from "@/errors";
import { asEmbassyId, callerRefFromEmbassy } from "@/ids";
import type { SaveResult } from "@/project-store/contracts";
import { parseFrontmatter } from "@/store/domain/frontmatter";
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
  return c.redirect(`/p/${row.projectId}/documents/${row.documentSlug}`, 302);
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

async function prepareWrite(
  c: EnvC,
  grant: EmbassyView["grant"],
): Promise<WritePrep> {
  const row = await liveEmbassy(c, c.req.param("token"));
  if (row === undefined)
    return { ok: false, response: c.text("not found", 404) };
  if (row.grant !== grant)
    return { ok: false, response: c.text("forbidden", 403) };
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
  grant: EmbassyView["grant"],
): Promise<Response | undefined> {
  const reserved = await reserveEmbassyWrite(prep.db, {
    id: prep.row.id,
    grant,
  });
  if (reserved) return undefined;
  const again = await resolveLiveEmbassy(prep.db, prep.row.id);
  if (again === undefined) return c.text("not found", 404);
  if (again.grant !== grant) return c.text("forbidden", 403);
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
  void noteEmbassyFetch(connectControlDb(c.env.DB), row.id, row.lastFetchedAt);
  if (html) {
    return c.html(
      embassyPageHtml({
        title: doc.title,
        markdown: doc.markdown,
        url: new URL(embassyPath(row.id), c.req.url).toString(),
        grant: row.grant,
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

const REPLACE_BODY_REQUIRED = "body required";

export async function embassyReplace(c: EnvC): Promise<Response> {
  const prep = await prepareWrite(c, "replace");
  if (!prep.ok) return prep.response;
  const store = storeFor(c.env, prep.row.projectId);
  const head = await store.getDocument(prep.row.documentSlug);
  if (head === undefined) return c.text("not found", 404);
  if (!isIntakeMarkdown(head.markdown)) return c.text("forbidden", 403);
  const fm = parseFrontmatter(prep.body);
  if (!fm.ok) {
    return c.text(`invalid YAML frontmatter: ${fm.error}`, 400);
  }
  if (isBlank(fm.body)) return c.text(REPLACE_BODY_REQUIRED, 400);
  const denied = await assertReplaceQuota(c, prep);
  if (denied !== undefined) return denied;
  const refused = await claimWrite(c, prep, "replace");
  if (refused !== undefined) return refused;
  const r = await saveReplace(store, prep);
  if (!r.ok) {
    await releaseClaim(prep);
    if ("conflict" in r) {
      return c.json(
        { ok: false, conflict: true, currentVersion: r.currentVersion },
        409,
      );
    }
    if ("tooLarge" in r) return c.text(MARKDOWN_TOO_LARGE_MESSAGE, 413);
    return c.json({ ok: false }, 409);
  }
  await spendEmbassyReplace(prep.db, prep.row.id);
  return c.json({ ok: true, docVersion: r.docVersion }, 200);
}

async function saveReplace(
  store: ReturnType<typeof storeFor>,
  prep: Extract<WritePrep, { ok: true }>,
): Promise<SaveResult> {
  try {
    return await store.saveDocument({
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

async function assertReplaceQuota(
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
