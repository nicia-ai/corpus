import { env, SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  apiKeyDisplayPrefix,
  generateApiKeyToken,
  hashApiKeyToken,
  setApiKeyGrant,
} from "../src/control/api-keys";
import { connectControlDb } from "../src/control/db";
import { apiKey } from "../src/control/schema/app";
import { storeFor } from "../src/control/store-for";
import { GRANT_TOO_LOW_CODE } from "../src/docs-rest";
import { GRANTS, type Grant } from "../src/grant";
import { asApiKeyId, asConnectionId } from "../src/ids";

import {
  type Corpus,
  newCorpus,
  OWNER,
  seed,
  siblingCorpus,
} from "./_cli-fixtures";
import { docSlug } from "./_helpers";

// The key's grant (read < suggest < edit) on every REST route: what each
// grant may do, the 403 body that tells a client what it may do instead, how
// a `suggest` write becomes a proposal, and that no grant ever reaches
// outside the key's corpus.

const BASE = "https://example.com";
const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_ACCEPTED = 202;
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;

type Json = Record<string, unknown>;

async function call(
  token: string,
  path: string,
  init: Readonly<{ method?: string; body?: unknown }> = {},
): Promise<Readonly<{ status: number; body: Json }>> {
  const res = await SELF.fetch(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

const put = (token: string, slug: string, body: unknown) =>
  call(token, `/api/v1/docs/${slug}`, { method: "PUT", body });
const post = (token: string, body: unknown) =>
  call(token, "/api/v1/docs", { method: "POST", body });
const remove = (token: string, slug: string, version: number) =>
  call(token, `/api/v1/docs/${slug}?clientVersion=${String(version)}`, {
    method: "DELETE",
  });
const move = (token: string, slug: string, path: string) =>
  call(token, `/api/v1/docs/${slug}/move`, { method: "POST", body: { path } });

async function corpusWith(grant: Grant): Promise<Corpus> {
  const corpus = await newCorpus(grant);
  await seed(corpus, "guide", "# Guide\n\nv1\n");
  return corpus;
}

describe("api key grants: read", () => {
  it("reports its grant, lists and fetches", async () => {
    const corpus = await corpusWith("read");
    const list = await call(corpus.token, "/api/v1/docs");
    expect(list.status).toBe(HTTP_OK);
    expect(list.body["grant"]).toBe("read");
    expect(
      await call(corpus.token, "/api/v1/docs/guide").then((r) => r.status),
    ).toBe(HTTP_OK);
  });

  it("refuses every write with a 403 that says what the key may do", async () => {
    const corpus = await corpusWith("read");
    const attempts = [
      await put(corpus.token, "guide", { markdown: "x", clientVersion: 1 }),
      await post(corpus.token, { markdown: "x", path: "new.md" }),
      await remove(corpus.token, "guide", 1),
      await move(corpus.token, "guide", "elsewhere.md"),
    ];
    for (const r of attempts) {
      expect(r.status).toBe(HTTP_FORBIDDEN);
      expect(r.body["code"]).toBe(GRANT_TOO_LOW_CODE);
      expect(r.body["grant"]).toBe("read");
      expect(String(r.body["error"])).toContain("read access");
      expect(r.body["allowed"]).toEqual([
        "list documents (GET /api/v1/docs)",
        "fetch one (GET /api/v1/docs/:slug)",
      ]);
    }
    expect(attempts.map((r) => r.body["needed"])).toEqual([
      "suggest",
      "suggest",
      "edit",
      "edit",
    ]);
    const store = storeFor(env, corpus.projectId);
    expect((await store.getDocument(docSlug("guide")))?.docVersion).toBe(1);
    expect(await store.listCreateProposals()).toEqual([]);
  });
});

describe("api key grants: suggest", () => {
  it("files an edit as a proposal attributed to the key over the CLI channel", async () => {
    const corpus = await corpusWith("suggest");
    const r = await put(corpus.token, "guide", {
      markdown: "# Guide\n\nv2 proposed\n",
      clientVersion: 1,
    });
    expect(r.status).toBe(HTTP_ACCEPTED);
    expect(r.body).toMatchObject({ ok: true, proposed: true, kind: "edit" });
    expect(String(r.body["reviewUrl"])).toContain(
      `/p/${corpus.projectId}/documents/guide#proposal-`,
    );

    const store = storeFor(env, corpus.projectId);
    const doc = await store.getDocument(docSlug("guide"));
    expect(doc?.docVersion).toBe(1);
    expect(doc?.markdown).toBe("# Guide\n\nv1\n");
    const [suggestion, ...rest] = await store.listSuggestions(docSlug("guide"));
    expect(rest).toEqual([]);
    expect(suggestion).toMatchObject({
      id: r.body["proposalId"],
      status: "open",
      channel: "cli",
      baseDocVersion: 1,
    });
    expect(suggestion?.createdBy).toMatch(/^apikey:/u);
  });

  it("applies like any other proposal once a person accepts it", async () => {
    const corpus = await corpusWith("suggest");
    const proposed = await put(corpus.token, "guide", {
      markdown: "# Guide\n\nv2 proposed\n",
      clientVersion: 1,
    });
    const store = storeFor(env, corpus.projectId);
    const [suggestion] = await store.listSuggestions(docSlug("guide"));
    for (const hunk of suggestion?.hunks ?? []) {
      await store.setHunkDecision({ hunkId: hunk.id, decision: "accepted" });
    }
    const applied = await store.applySuggestion({
      suggestionId: Number(proposed.body["proposalId"]),
      appliedBy: OWNER,
    });
    expect(applied).toMatchObject({ ok: true, docVersion: 2 });
    expect((await store.getDocument(docSlug("guide")))?.markdown).toBe(
      "# Guide\n\nv2 proposed\n",
    );
  });

  it("files a new document as a proposal, with a server-derived slug at its path", async () => {
    const corpus = await corpusWith("suggest");
    const r = await post(corpus.token, {
      markdown: "# Runbook\n",
      path: "ops/runbook.md",
    });
    expect(r.status).toBe(HTTP_ACCEPTED);
    expect(r.body).toMatchObject({ proposed: true, kind: "create" });
    const store = storeFor(env, corpus.projectId);
    const [proposal, ...rest] = await store.listCreateProposals();
    expect(rest).toEqual([]);
    expect(proposal).toMatchObject({ slug: r.body["slug"], channel: "cli" });
    expect(await store.getDocument(docSlug(String(r.body["slug"])))).toBe(
      undefined,
    );
  });

  it("files a PUT at version 0 as a create proposal, validating the slug it invents", async () => {
    const corpus = await corpusWith("suggest");
    const ok = await put(corpus.token, "fresh-page", {
      markdown: "# Fresh\n",
      clientVersion: 0,
      path: "notes/fresh-page.md",
    });
    expect(ok.status).toBe(HTTP_ACCEPTED);
    expect(ok.body).toMatchObject({ kind: "create", slug: "fresh-page" });
    const bad = await put(corpus.token, "Not A Slug", {
      markdown: "# x\n",
      clientVersion: 0,
    });
    expect(bad.status).toBe(HTTP_BAD_REQUEST);
  });

  it("reports a stale base as a conflict and an identical body as nothing to propose", async () => {
    const corpus = await corpusWith("suggest");
    const stale = await put(corpus.token, "guide", {
      markdown: "# Guide\n\nother\n",
      clientVersion: 7,
    });
    expect(stale.status).toBe(HTTP_CONFLICT);
    expect(stale.body).toMatchObject({ conflict: true, currentVersion: 1 });
    const same = await put(corpus.token, "guide", {
      markdown: "# Guide\n\nv1\n",
      clientVersion: 1,
    });
    expect(same.status).toBe(HTTP_OK);
    expect(same.body).toMatchObject({ proposed: false, noChange: true });
  });

  it("refuses removals and moves, because neither can be proposed", async () => {
    const corpus = await corpusWith("suggest");
    for (const r of [
      await remove(corpus.token, "guide", 1),
      await move(corpus.token, "guide", "elsewhere.md"),
    ]) {
      expect(r.status).toBe(HTTP_FORBIDDEN);
      expect(r.body).toMatchObject({
        code: GRANT_TOO_LOW_CODE,
        grant: "suggest",
        needed: "edit",
      });
      expect(String(r.body["error"])).toContain("cannot be proposed");
      expect(r.body["allowed"]).toContain(
        "propose an edit to a document (PUT /api/v1/docs/:slug)",
      );
    }
    const store = storeFor(env, corpus.projectId);
    expect((await store.getDocument(docSlug("guide")))?.docVersion).toBe(1);
  });
});

describe("api key grants: edit", () => {
  it("writes directly, as before", async () => {
    const corpus = await corpusWith("edit");
    const r = await put(corpus.token, "guide", {
      markdown: "# Guide\n\nv2\n",
      clientVersion: 1,
    });
    expect(r.body).toEqual({ ok: true, docVersion: 2 });
    const stale = await put(corpus.token, "guide", {
      markdown: "x",
      clientVersion: 1,
    });
    expect(stale.status).toBe(HTTP_CONFLICT);
  });

  it("creates at a nested path with a server-derived slug", async () => {
    const corpus = await corpusWith("edit");
    const r = await post(corpus.token, {
      markdown: "# Deploy\n",
      path: "runbooks/prod/deploy.md",
    });
    expect(r.status).toBe(HTTP_CREATED);
    const list = await call(corpus.token, "/api/v1/docs");
    const docs = list.body["documents"] as { slug: string; path: string }[];
    expect(docs.find((d) => d.slug === r.body["slug"])?.path).toBe(
      "runbooks/prod/deploy.md",
    );
    const second = await post(corpus.token, {
      markdown: "# Other\n",
      path: "elsewhere/deploy.md",
    });
    expect(second.body["slug"]).not.toBe(r.body["slug"]);
  });

  it("moves a document keeping its slug, version and history", async () => {
    const corpus = await corpusWith("edit");
    await put(corpus.token, "guide", {
      markdown: "# Guide\n\nv2\n",
      clientVersion: 1,
    });
    const r = await move(
      corpus.token,
      "guide",
      "docs/handbook/guide-renamed.md",
    );
    expect(r).toMatchObject({
      status: HTTP_OK,
      body: { ok: true, changed: true },
    });
    const list = await call(corpus.token, "/api/v1/docs");
    expect(list.body["documents"]).toEqual([
      expect.objectContaining({
        slug: "guide",
        docVersion: 2,
        path: "docs/handbook/guide-renamed.md",
      }),
    ]);
    const again = await move(
      corpus.token,
      "guide",
      "docs/handbook/guide-renamed.md",
    );
    expect(again.body).toMatchObject({ ok: true, changed: false });
    const history = await storeFor(env, corpus.projectId).verifyHistory(
      docSlug("guide"),
    );
    expect(history.ok).toBe(true);
  });

  it("refuses a move onto a taken name and changes nothing", async () => {
    const corpus = await corpusWith("edit");
    await seed(corpus, "other", "# Other\n");
    const r = await move(corpus.token, "guide", "other.md");
    expect(r.status).toBe(HTTP_CONFLICT);
    expect(r.body).toMatchObject({ segmentCollision: true });
    const list = await call(corpus.token, "/api/v1/docs");
    const paths = (list.body["documents"] as { path: string }[]).map(
      (d) => d.path,
    );
    expect(paths.sort()).toEqual(["guide.md", "other.md"]);
  });

  it("archives a document, guarded by the version the caller saw", async () => {
    const corpus = await corpusWith("edit");
    expect((await remove(corpus.token, "guide", 5)).status).toBe(HTTP_CONFLICT);
    expect(
      (await call(corpus.token, "/api/v1/docs/guide", { method: "DELETE" }))
        .status,
    ).toBe(HTTP_BAD_REQUEST);
    expect((await remove(corpus.token, "guide", 1)).body).toEqual({ ok: true });
    expect((await call(corpus.token, "/api/v1/docs/guide")).status).toBe(
      HTTP_NOT_FOUND,
    );
    expect((await remove(corpus.token, "guide", 1)).status).toBe(
      HTTP_NOT_FOUND,
    );
    const store = storeFor(env, corpus.projectId);
    expect(await store.getDocument(docSlug("guide"))).toBeUndefined();
    expect((await store.verifyHistory(docSlug("guide"))).ok).toBe(true);
  });

  it("rejects paths that leave the corpus", async () => {
    const corpus = await corpusWith("edit");
    for (const path of [
      "../x.md",
      "/abs.md",
      "a\\b.md",
      "a/../../b.md",
      "c:/x.md",
    ]) {
      expect((await post(corpus.token, { markdown: "x", path })).status).toBe(
        HTTP_BAD_REQUEST,
      );
      expect((await move(corpus.token, "guide", path)).status).toBe(
        HTTP_BAD_REQUEST,
      );
    }
  });
});

describe.each(GRANTS)("a %s key never reaches outside its corpus", (grant) => {
  it("treats another corpus and Drafts as nonexistent on every route", async () => {
    const mine = await corpusWith(grant);
    const theirs = await siblingCorpus(mine, "edit");
    await seed(theirs, "secret", "# Secret\n");
    const store = storeFor(env, mine.projectId);
    await store.saveDocument({
      slug: docSlug("draft-note"),
      markdown: "# Draft\n",
      clientVersion: 0,
      changedBy: OWNER,
    });

    for (const slug of ["secret", "draft-note"]) {
      expect((await call(mine.token, `/api/v1/docs/${slug}`)).status).toBe(
        HTTP_NOT_FOUND,
      );
      if (grant === "read") continue;
      expect(
        (await put(mine.token, slug, { markdown: "x", clientVersion: 1 }))
          .status,
      ).toBe(HTTP_NOT_FOUND);
      if (grant === "edit") {
        expect((await remove(mine.token, slug, 1)).status).toBe(HTTP_NOT_FOUND);
        expect((await move(mine.token, slug, "stolen.md")).status).toBe(
          HTTP_NOT_FOUND,
        );
      }
    }
    const listed = await call(mine.token, "/api/v1/docs");
    expect(
      (listed.body["documents"] as { slug: string }[]).map((d) => d.slug),
    ).toEqual(["guide"]);
    expect((await store.getDocument(docSlug("secret")))?.docVersion).toBe(1);
    expect((await store.getDocument(docSlug("draft-note")))?.docVersion).toBe(
      1,
    );
    expect(await store.listSuggestions(docSlug("secret"))).toEqual([]);
  });
});

async function keyRow(token: string) {
  const [row] = await connectControlDb(env.DB)
    .select()
    .from(apiKey)
    .where(eq(apiKey.tokenHash, await hashApiKeyToken(token)));
  if (row === undefined) throw new Error("key row missing");
  return row;
}

describe("changing a key's grant", () => {
  it("takes effect on the next request and is scoped by (connection, project)", async () => {
    const corpus = await corpusWith("read");
    const outsider = await newCorpus("read");
    const row = await keyRow(corpus.token);
    const db = connectControlDb(env.DB);
    const target = {
      id: asApiKeyId(row.id),
      connectionId: asConnectionId(row.connectionId),
    };
    expect((await call(corpus.token, "/api/v1/docs")).body["grant"]).toBe(
      "read",
    );

    const wrongProject = await setApiKeyGrant(db, {
      ...target,
      projectId: outsider.projectId,
      grant: "edit",
    });
    expect(wrongProject).toBe(false);
    expect((await call(corpus.token, "/api/v1/docs")).body["grant"]).toBe(
      "read",
    );

    const changed = await setApiKeyGrant(db, {
      ...target,
      projectId: corpus.projectId,
      grant: "suggest",
    });
    expect(changed).toBe(true);
    expect((await call(corpus.token, "/api/v1/docs")).body["grant"]).toBe(
      "suggest",
    );
  });

  it("gives a key minted without a grant (as every key was before grants) edit", async () => {
    const corpus = await corpusWith("read");
    const { connectionId } = await keyRow(corpus.token);
    const legacy = generateApiKeyToken();
    await connectControlDb(env.DB)
      .insert(apiKey)
      .values({
        userId: corpus.ownerUserId,
        organizationId: corpus.organizationId,
        connectionId,
        name: "legacy",
        tokenHash: await hashApiKeyToken(legacy),
        tokenPrefix: apiKeyDisplayPrefix(legacy),
      });
    expect((await keyRow(legacy)).grant).toBe("edit");
    expect((await call(legacy, "/api/v1/docs")).body["grant"]).toBe("edit");
    expect(
      (
        await put(legacy, "guide", {
          markdown: "# Guide\n\nlegacy\n",
          clientVersion: 1,
        })
      ).body,
    ).toEqual({ ok: true, docVersion: 2 });
  });
});
