import type { Context } from "hono";

import { getAuth } from "@/auth.server";
import { connectControlDb, type ControlDb } from "@/control/db";
import {
  EMBASSY_WRITE_LIMIT,
  noteEmbassyFetch,
  recordEmbassyWrite,
  resolveLiveEmbassy,
  type EmbassyView,
} from "@/control/embassies";
import { resolveProjectById } from "@/control/project-resolution";
import { storeFor } from "@/control/store-for";
import { embassyGoneHtml, embassyPageHtml } from "@/embassy/html";
import { isIntakeMarkdown } from "@/embassy/intake";
import { embassyPath } from "@/embassy/url";
import { asEmbassyId, callerRefFromEmbassy } from "@/ids";
import { MARKDOWN_TOO_LARGE_MESSAGE, markdownTooLarge } from "@/util";

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
  if (row.writeCount >= EMBASSY_WRITE_LIMIT) {
    return { ok: false, response: c.text("rate limited", 429) };
  }
  return {
    ok: true,
    row,
    clientVersion,
    body,
    db: connectControlDb(c.env.DB),
  };
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
  const r = await storeFor(c.env, prep.row.projectId).createSuggestion({
    slug: prep.row.documentSlug,
    proposedMarkdown: prep.body,
    clientVersion: prep.clientVersion,
    createdBy: callerRefFromEmbassy(prep.row.id),
    channel: "cli",
  });
  if (r.ok) {
    await recordEmbassyWrite(prep.db, { id: prep.row.id });
    return c.json({ ok: true, suggestionId: r.suggestionId }, 201);
  }
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

export async function embassyReplace(c: EnvC): Promise<Response> {
  const prep = await prepareWrite(c, "replace");
  if (!prep.ok) return prep.response;
  const store = storeFor(c.env, prep.row.projectId);
  const head = await store.getDocument(prep.row.documentSlug);
  if (head === undefined) return c.text("not found", 404);
  if (!isIntakeMarkdown(head.markdown)) return c.text("forbidden", 403);
  const r = await store.saveDocument({
    slug: prep.row.documentSlug,
    markdown: prep.body,
    clientVersion: prep.clientVersion,
    changedBy: callerRefFromEmbassy(prep.row.id),
  });
  if (r.ok) {
    await recordEmbassyWrite(prep.db, {
      id: prep.row.id,
      flipGrantToSuggest: true,
    });
    return c.json({ ok: true, docVersion: r.docVersion }, 200);
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
