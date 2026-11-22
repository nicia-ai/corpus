import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { storeFor } from "../../src/control/store-for";
import { GRANT_TOO_LOW_CODE } from "../../src/docs-rest";
import type { Grant } from "../../src/grant";
import { fileObjectKey } from "../../src/store/repos/object-store";
import { MAX_FILE_BYTES } from "../../src/util";
import {
  type Corpus,
  keyFor,
  newCorpus,
  seed,
  siblingCorpus,
} from "../_cli-fixtures";
import { hashOf, noisyPng, pdf, png } from "../_images";

import { objects } from "./_support";

// The files REST surface (`/api/v1/files`) with an API key: listing, a
// download verified against its hash, create / replace with `If-Match`,
// delete, move, and the grants — a `suggest` key cannot write a binary because
// there is nothing to propose.

type Reply = Readonly<{
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
  bytes: Uint8Array;
}>;

async function call(
  token: string,
  method: string,
  path: string,
  init: Readonly<{
    body?: BodyInit;
    headers?: Record<string, string>;
  }> = {},
): Promise<Reply> {
  const res = await SELF.fetch(`https://example.com${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...init.headers },
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed === "object" && parsed !== null) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // A binary body.
  }
  return { status: res.status, body, headers: res.headers, bytes };
}

const put = (
  token: string,
  path: string,
  bytes: Uint8Array<ArrayBuffer>,
  ifMatch?: string,
): Promise<Reply> =>
  call(token, "PUT", `/api/v1/files?path=${encodeURIComponent(path)}`, {
    body: bytes,
    headers: ifMatch === undefined ? {} : { "if-match": `"${ifMatch}"` },
  });

const list = async (
  token: string,
): Promise<readonly Record<string, unknown>[]> => {
  const r = await call(token, "GET", "/api/v1/files");
  expect(r.status).toBe(200);
  return r.body["files"] as Record<string, unknown>[];
};

async function corpus(grant: Grant = "edit"): Promise<Corpus> {
  return newCorpus(grant);
}

describe("GET /api/v1/files", () => {
  it("lists the corpus's files with path, hash, size and type — and no other corpus's", async () => {
    const a = await corpus();
    const b = await siblingCorpus(a);
    await put(a.token, "img/a.png", png("a"));
    await put(a.token, "doc.pdf", pdf("d"));
    await put(b.token, "other.png", png("o"));

    expect(await list(a.token)).toEqual([
      {
        slug: expect.any(String),
        path: "doc.pdf",
        sha256: await hashOf(pdf("d")),
        size: pdf("d").byteLength,
        contentType: "application/pdf",
      },
      {
        slug: expect.any(String),
        path: "img/a.png",
        sha256: await hashOf(png("a")),
        size: png("a").byteLength,
        contentType: "image/png",
      },
    ]);
    expect((await list(b.token)).map((f) => f["path"])).toEqual(["other.png"]);
  });

  it("answers 401 without a key", async () => {
    const r = await SELF.fetch("https://example.com/api/v1/files");
    expect(r.status).toBe(401);
  });

  it("is open to a read key, which can list and download", async () => {
    const owner = await corpus();
    await put(owner.token, "a.png", png("a"));
    const reader = await keyFor(owner, "read");
    const [file] = await list(reader);
    const r = await call(
      reader,
      "GET",
      `/api/v1/files/${String(file?.["slug"])}`,
    );
    expect(r.status).toBe(200);
    expect(r.bytes).toEqual(png("a"));
  });
});

describe("GET /api/v1/files/:slug", () => {
  it("serves the bytes with the stored type, as an attachment, behind the hash", async () => {
    const c = await corpus();
    const created = await put(c.token, "img/a.png", png("a"));
    const slug = String(created.body["slug"]);
    const r = await call(c.token, "GET", `/api/v1/files/${slug}`);
    expect(r.status).toBe(200);
    expect(r.bytes).toEqual(png("a"));
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("etag")).toBe(`"${await hashOf(png("a"))}"`);
    // A slug names the file, not its bytes: nothing is cached against it.
    expect(r.headers.get("cache-control")).toBe("private, no-cache");
  });

  it("serves a PDF as an attachment", async () => {
    const c = await corpus();
    const created = await put(c.token, "spec.pdf", pdf("s"));
    const r = await call(
      c.token,
      "GET",
      `/api/v1/files/${String(created.body["slug"])}`,
    );
    expect(r.headers.get("content-disposition")).toContain("attachment");
    expect(r.headers.get("content-type")).toBe("application/pdf");
  });

  it("never serves bytes that fail the stored hash", async () => {
    const c = await corpus();
    const created = await put(c.token, "a.png", png("a"));
    const hash = String(created.body["sha256"]);
    // Rot in the bucket: the object under the key is no longer those bytes.
    await objects().put(fileObjectKey(c.projectId, hash), png("rotten"));
    const r = await call(
      c.token,
      "GET",
      `/api/v1/files/${String(created.body["slug"])}`,
    );
    expect(r.status).toBe(502);
    expect(r.bytes).not.toEqual(png("rotten"));
  });

  it("answers 404 for a file of another corpus, as if it did not exist", async () => {
    const a = await corpus();
    const b = await siblingCorpus(a);
    const theirs = await put(b.token, "x.png", png("x"));
    const r = await call(
      a.token,
      "GET",
      `/api/v1/files/${String(theirs.body["slug"])}`,
    );
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "not found" });
  });
});

describe("PUT /api/v1/files?path=", () => {
  it("creates a file where the path is free (201) and creates its folders", async () => {
    const c = await corpus();
    const r = await put(c.token, "a/b/c.png", png("c"));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      ok: true,
      path: "a/b/c.png",
      created: true,
      sha256: await hashOf(png("c")),
      size: png("c").byteLength,
    });
  });

  it("is idempotent for the same bytes at the same path (200, nothing changes)", async () => {
    const c = await corpus();
    const first = await put(c.token, "a.png", png("a"));
    const again = await put(c.token, "a.png", png("a"));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: false, changed: false });
    expect(again.body["slug"]).toBe(first.body["slug"]);
  });

  it("replaces in place when If-Match is the current hash, keeping the slug", async () => {
    const c = await corpus();
    const first = await put(c.token, "a.png", png("v1"));
    const r = await put(c.token, "a.png", png("v2"), await hashOf(png("v1")));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      created: false,
      changed: true,
      slug: first.body["slug"],
      sha256: await hashOf(png("v2")),
    });
    const [only] = await list(c.token);
    expect(only?.["sha256"]).toBe(await hashOf(png("v2")));
  });

  it("answers 412 with the current hash when If-Match is stale, changing nothing", async () => {
    const c = await corpus();
    await put(c.token, "a.png", png("v1"));
    await put(c.token, "a.png", png("v2"), await hashOf(png("v1")));
    const r = await put(c.token, "a.png", png("v3"), await hashOf(png("v1")));
    expect(r.status).toBe(412);
    expect(r.body).toEqual({
      ok: false,
      conflict: true,
      currentSha256: await hashOf(png("v2")),
    });
    expect((await list(c.token))[0]?.["sha256"]).toBe(await hashOf(png("v2")));
  });

  it("answers 412 without If-Match when a different file is already there", async () => {
    const c = await corpus();
    await put(c.token, "a.png", png("v1"));
    const r = await put(c.token, "a.png", png("v2"));
    expect(r.status).toBe(412);
    expect(r.body["currentSha256"]).toBe(await hashOf(png("v1")));
  });

  it("answers 412 with no current hash when If-Match names a file that is gone", async () => {
    const c = await corpus();
    const r = await put(
      c.token,
      "gone.png",
      png("x"),
      await hashOf(png("old")),
    );
    expect(r.status).toBe(412);
    expect(r.body["currentSha256"]).toBeNull();
    expect(await list(c.token)).toEqual([]);
  });

  it("refuses an If-Match that is not a hash", async () => {
    const c = await corpus();
    const r = await call(c.token, "PUT", "/api/v1/files?path=a.png", {
      body: png("a"),
      headers: { "if-match": "v1" },
    });
    expect(r.status).toBe(400);
  });

  it("answers 409 when a folder already has the name", async () => {
    const c = await corpus();
    await seed(c, "guide", "# Guide\n", "taken.png");
    const folderTaken = await put(c.token, "taken.png", png("a"));
    expect(folderTaken.status).toBe(409);
    expect(folderTaken.body).toMatchObject({ segmentCollision: true });
  });

  it("applies the server's sniffing and limits: a renamed program, a lying extension, a bad name, size", async () => {
    const c = await corpus();
    const exe = new TextEncoder().encode("MZ\u0090\u0000 not an image");
    expect((await put(c.token, "tool.png", exe)).status).toBe(415);
    expect((await put(c.token, "pic.pdf", png("a"))).status).toBe(422);
    const spaced = await put(c.token, "my pic.png", png("a"));
    expect(spaced.status).toBe(422);
    expect(String(spaced.body["error"])).toContain("my-pic.png");
    expect((await put(c.token, "Photo.PNG", png("a"))).status).toBe(422);
    const huge = noisyPng(MAX_FILE_BYTES + 1, 1);
    expect((await put(c.token, "huge.png", huge)).status).toBe(413);
    expect((await put(c.token, "empty.png", new Uint8Array(0))).status).toBe(
      400,
    );
    expect(await list(c.token)).toEqual([]);
  });

  it("refuses an unsafe path before reading the body", async () => {
    const c = await corpus();
    for (const path of ["../x.png", "/x.png", "a\\b.png", "C:/x.png"]) {
      const r = await put(c.token, path, png("a"));
      expect({ path, status: r.status }).toEqual({ path, status: 400 });
    }
    expect(await list(c.token)).toEqual([]);
  });

  it("puts the bytes in R2 before the metadata, under the project's prefix", async () => {
    const c = await corpus();
    const r = await put(c.token, "a.png", png("a"));
    const stored = await objects().get(
      fileObjectKey(c.projectId, String(r.body["sha256"])),
    );
    expect(stored?.size).toBe(png("a").byteLength);
  });
});

describe("DELETE /api/v1/files/:slug", () => {
  it("deletes, frees the name, and a stale If-Match deletes nothing", async () => {
    const c = await corpus();
    const created = await put(c.token, "a.png", png("a"));
    const slug = String(created.body["slug"]);
    const stale = await call(c.token, "DELETE", `/api/v1/files/${slug}`, {
      headers: { "if-match": `"${await hashOf(png("other"))}"` },
    });
    expect(stale.status).toBe(412);
    expect(stale.body["currentSha256"]).toBe(await hashOf(png("a")));
    expect(await list(c.token)).toHaveLength(1);

    const ok = await call(c.token, "DELETE", `/api/v1/files/${slug}`, {
      headers: { "if-match": `"${await hashOf(png("a"))}"` },
    });
    expect(ok.status).toBe(200);
    expect(await list(c.token)).toEqual([]);
    expect((await call(c.token, "GET", `/api/v1/files/${slug}`)).status).toBe(
      404,
    );
    // The name is free again.
    expect((await put(c.token, "a.png", png("b"))).status).toBe(201);
  });

  it("answers 404 for a file of another corpus", async () => {
    const a = await corpus();
    const b = await siblingCorpus(a);
    const theirs = await put(b.token, "x.png", png("x"));
    const r = await call(
      a.token,
      "DELETE",
      `/api/v1/files/${String(theirs.body["slug"])}`,
    );
    expect(r.status).toBe(404);
    expect(await list(b.token)).toHaveLength(1);
  });
});

describe("POST /api/v1/files/:slug/move", () => {
  it("moves and renames within the corpus, keeping the slug and bytes", async () => {
    const c = await corpus();
    const created = await put(c.token, "a.png", png("a"));
    const slug = String(created.body["slug"]);
    const r = await call(c.token, "POST", `/api/v1/files/${slug}/move`, {
      body: JSON.stringify({ path: "img/deep/b.png" }),
      headers: { "content-type": "application/json" },
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, changed: true });
    expect(await list(c.token)).toEqual([
      expect.objectContaining({
        slug,
        path: "img/deep/b.png",
        sha256: await hashOf(png("a")),
      }),
    ]);
  });

  it("refuses a name that is taken (409) or that changes the type (422)", async () => {
    const c = await corpus();
    const a = await put(c.token, "a.png", png("a"));
    await put(c.token, "b.png", png("b"));
    const move = (path: string): Promise<Reply> =>
      call(c.token, "POST", `/api/v1/files/${String(a.body["slug"])}/move`, {
        body: JSON.stringify({ path }),
        headers: { "content-type": "application/json" },
      });
    expect((await move("b.png")).status).toBe(409);
    expect((await move("a.pdf")).status).toBe(422);
    expect((await move("../a.png")).status).toBe(400);
    expect((await list(c.token)).map((f) => f["path"])).toEqual([
      "a.png",
      "b.png",
    ]);
  });

  it("answers 404 for a file of another corpus", async () => {
    const a = await corpus();
    const b = await siblingCorpus(a);
    const theirs = await put(b.token, "x.png", png("x"));
    const r = await call(
      a.token,
      "POST",
      `/api/v1/files/${String(theirs.body["slug"])}/move`,
      {
        body: JSON.stringify({ path: "y.png" }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(r.status).toBe(404);
  });
});

describe("grants", () => {
  it.each(["read", "suggest"] as const)(
    "a %s key can read files but is told it needs edit access to write one",
    async (grant) => {
      const owner = await corpus();
      const created = await put(owner.token, "a.png", png("a"));
      const slug = String(created.body["slug"]);
      const key = await keyFor(owner, grant);

      expect((await call(key, "GET", "/api/v1/files")).status).toBe(200);
      expect((await call(key, "GET", `/api/v1/files/${slug}`)).status).toBe(
        200,
      );

      const attempts = [
        await put(key, "b.png", png("b")),
        await put(key, "a.png", png("a2"), await hashOf(png("a"))),
        await call(key, "DELETE", `/api/v1/files/${slug}`),
        await call(key, "POST", `/api/v1/files/${slug}/move`, {
          body: JSON.stringify({ path: "z.png" }),
          headers: { "content-type": "application/json" },
        }),
      ];
      for (const r of attempts) {
        expect(r.status).toBe(403);
        expect(r.body).toMatchObject({
          code: GRANT_TOO_LOW_CODE,
          grant,
          needed: "edit",
        });
        expect(String(r.body["error"])).toContain("edit access");
        expect(String(r.body["error"])).toContain("cannot be proposed");
        expect(r.body["allowed"]).toContain(
          "download one (GET /api/v1/files/:slug)",
        );
      }
      // Nothing was written.
      expect((await list(owner.token)).map((f) => f["path"])).toEqual([
        "a.png",
      ]);
      expect((await list(owner.token))[0]?.["sha256"]).toBe(
        await hashOf(png("a")),
      );
    },
  );

  it("records a replacement as a file.replaced change with both hashes", async () => {
    const c = await corpus();
    await put(c.token, "a.png", png("v1"));
    await put(c.token, "a.png", png("v2"), await hashOf(png("v1")));
    const events = await runInDurableObject(
      storeFor(env, c.projectId),
      (_instance, state) =>
        state.storage.sql
          .exec<{ event_type: string; after_json: string }>(
            "select event_type, after_json from change_events where event_type like 'file.%' order by id",
          )
          .toArray(),
    );
    expect(events.map((e) => e.event_type)).toEqual([
      "file.created",
      "file.replaced",
    ]);
    expect(JSON.parse(events[1]?.after_json ?? "{}")).toMatchObject({
      contentHash: await hashOf(png("v2")),
      previousHash: await hashOf(png("v1")),
    });
  });
});
