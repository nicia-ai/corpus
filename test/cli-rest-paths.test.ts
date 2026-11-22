import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { FetchLike, TreeFiles } from "../cli/core";
import { pullAll } from "../cli/sync";
import {
  apiKeyDisplayPrefix,
  generateApiKeyToken,
  hashApiKeyToken,
} from "../src/control/api-keys";
import { connectControlDb } from "../src/control/db";
import { apiKey } from "../src/control/schema/app";
import { storeFor } from "../src/control/store-for";
import type { CorpusSlug, ProjectId } from "../src/ids";
import { corpusRootFolderSlug } from "../src/store/domain/corpus-drive";
import { DEFAULT_CORPUS_SLUG } from "../src/store/domain/default-corpus";

import {
  createConnection,
  createCorpusFor,
  createOrg,
  docSlug,
  signUp,
} from "./_helpers";

// The REST surface speaks corpus-relative paths only: the hidden root
// folder never shows, a new document lands where the key's corpus says, and
// a document that has left the corpus is simply not there.

const OWNER = "rest-paths";
const sameWorkerFetch: FetchLike = (input, init) => SELF.fetch(input, init);

type Key = Readonly<{
  token: string;
  corpusSlug: CorpusSlug;
  projectId: ProjectId;
}>;

async function mintKey(): Promise<Key> {
  const ownerUserId = await signUp("rp");
  const ref = await createOrg(ownerUserId, "Org rp");
  const conn = await createConnection({
    organizationId: ref.organizationId,
    projectId: ref.projectId,
  });
  await createCorpusFor(ref.projectId, conn.corpusSlug);
  const token = generateApiKeyToken();
  await connectControlDb(env.DB)
    .insert(apiKey)
    .values({
      userId: ownerUserId,
      organizationId: ref.organizationId,
      connectionId: conn.connectionId,
      name: "rp",
      tokenHash: await hashApiKeyToken(token),
      tokenPrefix: apiKeyDisplayPrefix(token),
    });
  return { token, corpusSlug: conn.corpusSlug, projectId: ref.projectId };
}

function call(path: string, key: Key, body?: unknown): Promise<Response> {
  return SELF.fetch(`https://example.com${path}`, {
    method: body === undefined ? "GET" : "PUT",
    headers: {
      authorization: `Bearer ${key.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function listed(
  key: Key,
): Promise<readonly { slug: string; path: string }[]> {
  const body: { documents: { slug: string; path: string }[] } = await (
    await call("/api/v1/docs", key)
  ).json();
  return body.documents;
}

const put = (key: Key, slug: string, body: object) =>
  call(`/api/v1/docs/${slug}`, key, body);

describe("REST create: where a new document lands", () => {
  it("defaults to the corpus top level", async () => {
    const key = await mintKey();
    expect(
      (await put(key, "top", { markdown: "# Top", clientVersion: 0 })).status,
    ).toBe(200);
    expect(await listed(key)).toEqual([
      expect.objectContaining({ slug: "top", path: "top.md" }),
    ]);
  });

  it("accepts an optional corpus-relative path, creating the folders, and never exposes the root", async () => {
    const key = await mintKey();
    const created = await put(key, "refunds", {
      markdown: "# Refunds",
      clientVersion: 0,
      path: "policies/support/refunds.md",
    });
    expect(created.status).toBe(200);

    const docs = await listed(key);
    expect(docs).toEqual([
      expect.objectContaining({
        slug: "refunds",
        path: "policies/support/refunds.md",
      }),
    ]);
    const store = storeFor(env, key.projectId);
    expect(await store.documentLocation(docSlug("refunds"))).toMatchObject({
      corpusSlug: key.corpusSlug,
      path: "policies/support/refunds.md",
    });

    // The root's name (its corpus slug) and slug appear in no path a REST
    // client — or a CLI checkout built from it — can see.
    const hidden = [
      key.corpusSlug as string,
      corpusRootFolderSlug(key.corpusSlug),
    ];
    const written: string[] = [];
    const files: TreeFiles = {
      readText: () => Promise.resolve(undefined),
      writeText: (path) => {
        written.push(path);
        return Promise.resolve();
      },
      readBytes: () => Promise.resolve(undefined),
      writeBytes: (path) => {
        written.push(path);
        return Promise.resolve();
      },
      remove: () => Promise.resolve(),
    };
    await pullAll(
      {
        baseUrl: "https://example.com",
        apiKey: key.token,
        fetch: sameWorkerFetch,
        files,
      },
      "checkout",
    );
    expect(written).toContain("checkout/policies/support/refunds.md");
    for (const path of [...docs.map((d) => d.path), ...written]) {
      for (const secret of hidden) expect(path).not.toContain(secret);
    }
  });

  it("refuses a path that leaves the corpus, writing nothing", async () => {
    const key = await mintKey();
    for (const path of [
      "../x.md",
      "a/../../x.md",
      "/abs.md",
      "a\\b.md",
      "C:/x.md",
    ]) {
      const r = await put(key, "escape", {
        markdown: "x",
        clientVersion: 0,
        path,
      });
      expect(`${path} -> ${String(r.status)}`).toBe(`${path} -> 400`);
    }
    expect(await listed(key)).toEqual([]);
    expect(await storeFor(env, key.projectId).listFolders()).toEqual([]);
  });

  it("409s a path whose name a sibling already holds", async () => {
    const key = await mintKey();
    await put(key, "first", { markdown: "1", clientVersion: 0, path: "a.md" });
    const r = await put(key, "second", {
      markdown: "2",
      clientVersion: 0,
      path: "a.md",
    });
    expect(r.status).toBe(409);
    expect((await listed(key)).map((d) => d.slug)).toEqual(["first"]);
  });

  it("ignores the path for a document that already exists", async () => {
    const key = await mintKey();
    await put(key, "stay", {
      markdown: "v1",
      clientVersion: 0,
      path: "x/stay.md",
    });
    const r = await put(key, "stay", {
      markdown: "v2",
      clientVersion: 1,
      path: "elsewhere/stay.md",
    });
    expect(r.status).toBe(200);
    expect((await listed(key))[0]?.path).toBe("x/stay.md");
  });
});

describe("a document that has left the key's corpus", () => {
  async function leaves(to: CorpusSlug | "other-corpus") {
    const key = await mintKey();
    await put(key, "gone", { markdown: "v1", clientVersion: 0 });
    const store = storeFor(env, key.projectId);
    await store.ensureDefaultCorpus(OWNER);
    if (to === "other-corpus") {
      await createCorpusFor(key.projectId, "elsewhere" as CorpusSlug);
    }
    await store.moveDocument(
      docSlug("gone"),
      {
        corpusSlug: to === "other-corpus" ? ("elsewhere" as CorpusSlug) : to,
        folderSlug: null,
      },
      OWNER,
    );
    return key;
  }

  for (const [label, to] of [
    ["drafts", DEFAULT_CORPUS_SLUG],
    ["another corpus", "other-corpus"],
  ] as const) {
    it(`is not listed, 404s on read, 404s on update (moved to ${label})`, async () => {
      const key = await leaves(to);
      expect(await listed(key)).toEqual([]);
      expect((await call("/api/v1/docs/gone", key)).status).toBe(404);
      const update = await put(key, "gone", {
        markdown: "v2",
        clientVersion: 1,
      });
      expect(update.status).toBe(404);
      const nowhere = await put(key, "no-such", {
        markdown: "v2",
        clientVersion: 1,
      });
      expect(nowhere.status).toBe(update.status);
      // And nothing was written through the key.
      const head = await storeFor(env, key.projectId).getDocument(
        docSlug("gone"),
      );
      expect(head?.markdown).toBe("v1");
    });
  }
});
