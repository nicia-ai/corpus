import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { FetchLike } from "../../cli/core";
import { formatPushReport, pushAll } from "../../cli/push-all";
import { pullAll } from "../../cli/sync";
import { parseState, STATE_FILE } from "../../cli/sync-state";
import { storeFor } from "../../src/control/store-for";
import type { Grant } from "../../src/grant";
import {
  type Corpus,
  configFor,
  DIR,
  edit,
  keyFor,
  type MemoryTree,
  memoryTree,
  newCorpus,
  seed,
} from "../_cli-fixtures";
import { hashOf, jpeg, pdf, png } from "../_images";

// `pull --all` and `push --all` with images and attachments, end to end against
// the test worker: a real key, real R2, the real REST surface.

const at = (path: string): string => `${DIR}/${path}`;

type Checkout = Readonly<{ corpus: Corpus; tree: MemoryTree }>;

// The server's side of a file, written the way any client would: over REST.
async function serverPut(
  token: string,
  path: string,
  bytes: Uint8Array<ArrayBuffer>,
  ifMatch?: string,
): Promise<number> {
  const res = await SELF.fetch(
    `https://example.com/api/v1/files?path=${encodeURIComponent(path)}`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        ...(ifMatch === undefined ? {} : { "if-match": `"${ifMatch}"` }),
      },
      body: bytes,
    },
  );
  return res.status;
}

async function serverFiles(
  corpus: Corpus,
): Promise<ReadonlyMap<string, string>> {
  const files = await storeFor(env, corpus.projectId).corpusFiles(
    corpus.corpusSlug,
  );
  return new Map(files.map((f) => [f.path, f.contentHash]));
}

// A corpus with a page and two images, pulled into a fresh in-memory tree.
async function checkout(grant: Grant): Promise<Checkout> {
  const corpus = await newCorpus(grant);
  await seed(corpus, "readme", "# Readme\n\n![a](./a.png)\n");
  const owner = await keyFor(corpus, "edit");
  expect(await serverPut(owner, "a.png", png("a"))).toBe(201);
  expect(await serverPut(owner, "img/b.jpg", jpeg("b"))).toBe(201);
  const tree = memoryTree();
  await pullAll(configFor(corpus, tree), DIR);
  return { corpus, tree };
}

function stateOf(tree: MemoryTree) {
  return parseState(tree.map.get(at(STATE_FILE)) ?? "", STATE_FILE);
}

// A fetch that counts the file writes that reach the server.
function countingFetch(): Readonly<{
  fetch: FetchLike;
  calls: string[];
}> {
  const calls: string[] = [];
  return {
    calls,
    fetch: (input, init) => {
      const method = init?.method ?? "GET";
      if (
        method !== "GET" &&
        new URL(input).pathname.startsWith("/api/v1/files")
      ) {
        calls.push(`${method} ${new URL(input).pathname}`);
      }
      return SELF.fetch(input, init);
    },
  };
}

describe("a checkout with images", () => {
  it("pulls them, tracks them, and a push straight after has nothing to do", async () => {
    const c = await checkout("edit");
    expect(c.tree.binary.get(at("a.png"))).toEqual(png("a"));
    expect(c.tree.binary.get(at("img/b.jpg"))).toEqual(jpeg("b"));
    expect(stateOf(c.tree).assets?.map((a) => a.path)).toEqual([
      "a.png",
      "img/b.jpg",
    ]);

    const report = await pushAll(configFor(c.corpus, c.tree), DIR);
    expect(report).toMatchObject({
      planned: [],
      applied: [],
      conflicts: [],
      failed: [],
      unchanged: 3,
    });
  });
});

describe("push --all and images (edit access)", () => {
  it("uploads an untracked image and tracks it; a pull after is up to date", async () => {
    const c = await checkout("edit");
    c.tree.binary.set(at("new/c.png"), png("c"));

    const report = await pushAll(configFor(c.corpus, c.tree), DIR);

    expect(report.applied).toEqual([{ path: "new/c.png", action: "created" }]);
    expect((await serverFiles(c.corpus)).get("new/c.png")).toBe(
      await hashOf(png("c")),
    );
    expect(stateOf(c.tree).assets?.find((a) => a.path === "new/c.png")).toEqual(
      {
        path: "new/c.png",
        slug: expect.any(String),
        sha256: await hashOf(png("c")),
        size: png("c").byteLength,
      },
    );
    const writes = c.tree.writes.length;
    await pullAll(configFor(c.corpus, c.tree), DIR);
    expect(c.tree.writes.length).toBe(writes);
  });

  it("replaces a changed tracked image, keeping its slug", async () => {
    const c = await checkout("edit");
    const slugBefore = stateOf(c.tree).assets?.find(
      (a) => a.path === "a.png",
    )?.slug;
    c.tree.binary.set(at("a.png"), png("a, retouched"));

    const report = await pushAll(configFor(c.corpus, c.tree), DIR);

    expect(report.applied).toEqual([{ path: "a.png", action: "updated" }]);
    expect((await serverFiles(c.corpus)).get("a.png")).toBe(
      await hashOf(png("a, retouched")),
    );
    const after = stateOf(c.tree).assets?.find((a) => a.path === "a.png");
    expect(after?.slug).toBe(slugBefore);
    expect(after?.sha256).toBe(await hashOf(png("a, retouched")));
  });

  it("reports a conflict when upstream changed, leaves it, and carries on with the rest", async () => {
    const c = await checkout("edit");
    const owner = await keyFor(c.corpus, "edit");
    expect(
      await serverPut(owner, "a.png", png("theirs"), await hashOf(png("a"))),
    ).toBe(200);
    c.tree.binary.set(at("a.png"), png("mine"));
    c.tree.binary.set(at("fresh.png"), png("fresh"));
    c.tree.map.set(at("readme.md"), "# Readme, edited\n");

    const report = await pushAll(configFor(c.corpus, c.tree), DIR);

    expect(report.conflicts).toEqual([
      { path: "a.png", slug: expect.any(String), reason: "changed-upstream" },
    ]);
    expect(report.applied.map((a) => a.path).sort()).toEqual([
      "fresh.png",
      "readme.md",
    ]);
    expect((await serverFiles(c.corpus)).get("a.png")).toBe(
      await hashOf(png("theirs")),
    );
    // The conflicting file is left exactly as the user had it.
    expect(c.tree.binary.get(at("a.png"))).toEqual(png("mine"));
    expect(formatPushReport(report, DIR).join("\n")).toContain("a.png");
  });

  it("reports a replace of an image deleted upstream as a conflict", async () => {
    const c = await checkout("edit");
    const slug =
      stateOf(c.tree).assets?.find((a) => a.path === "a.png")?.slug ?? "";
    await storeFor(env, c.corpus.projectId).deleteFileInCorpus(
      slug as never,
      c.corpus.corpusSlug,
      undefined,
      "test",
    );
    c.tree.binary.set(at("a.png"), png("mine"));
    const report = await pushAll(configFor(c.corpus, c.tree), DIR);
    expect(report.conflicts).toEqual([
      { path: "a.png", slug, reason: "deleted-upstream" },
    ]);
    expect(report.applied).toEqual([]);
  });

  it("deletes an image removed locally, like a removed page", async () => {
    const c = await checkout("edit");
    c.tree.binary.delete(at("img/b.jpg"));

    const report = await pushAll(configFor(c.corpus, c.tree), DIR);

    expect(report.applied).toEqual([{ path: "img/b.jpg", action: "archived" }]);
    expect([...(await serverFiles(c.corpus)).keys()]).toEqual(["a.png"]);
    expect(stateOf(c.tree).assets?.map((a) => a.path)).toEqual(["a.png"]);
  });

  it("leaves a locally removed image alone when upstream changed it since", async () => {
    const c = await checkout("edit");
    const owner = await keyFor(c.corpus, "edit");
    await serverPut(
      owner,
      "img/b.jpg",
      jpeg("theirs"),
      await hashOf(jpeg("b")),
    );
    c.tree.binary.delete(at("img/b.jpg"));

    const report = await pushAll(configFor(c.corpus, c.tree), DIR);

    expect(report.conflicts).toMatchObject([
      { path: "img/b.jpg", reason: "changed-upstream" },
    ]);
    expect([...(await serverFiles(c.corpus)).keys()].sort()).toEqual([
      "a.png",
      "img/b.jpg",
    ]);
  });

  it("turns a rename into a move that keeps the slug", async () => {
    const c = await checkout("edit");
    const slug = stateOf(c.tree).assets?.find((a) => a.path === "a.png")?.slug;
    const bytes = c.tree.binary.get(at("a.png"));
    c.tree.binary.delete(at("a.png"));
    if (bytes !== undefined)
      c.tree.binary.set(at("moved/a-renamed.png"), bytes);

    const report = await pushAll(configFor(c.corpus, c.tree), DIR);

    expect(report.applied).toEqual([
      { path: "moved/a-renamed.png", action: "moved", from: "a.png" },
    ]);
    const entry = stateOf(c.tree).assets?.find(
      (a) => a.path === "moved/a-renamed.png",
    );
    expect(entry?.slug).toBe(slug);
    expect((await serverFiles(c.corpus)).has("a.png")).toBe(false);
    expect((await serverFiles(c.corpus)).get("moved/a-renamed.png")).toBe(
      await hashOf(png("a")),
    );
  });

  it("re-matches an image by its hash instead of uploading it again (state written by a CLI without images)", async () => {
    const c = await checkout("edit");
    // What an older CLI's `pull --all` leaves: the files, a state without assets.
    const previous = stateOf(c.tree);
    c.tree.map.set(
      at(STATE_FILE),
      `${JSON.stringify({ version: 1, corpus: previous.corpus, files: previous.files }, null, 2)}\n`,
    );
    const counted = countingFetch();

    const report = await pushAll(
      configFor(c.corpus, c.tree, counted.fetch),
      DIR,
    );

    expect(counted.calls).toEqual([]);
    expect(report.applied).toEqual([]);
    expect(report.conflicts).toEqual([]);
    expect(stateOf(c.tree).assets?.map((a) => a.path)).toEqual([
      "a.png",
      "img/b.jpg",
    ]);
  });

  it("does not offer a file that is not an allowed type, and the server refuses one that lies", async () => {
    const c = await checkout("edit");
    c.tree.binary.set(at("tool.exe"), new Uint8Array([0x4d, 0x5a]));
    c.tree.map.set(at("notes.txt"), "x");
    c.tree.map.set(at("fake.png"), "this is not a png");
    c.tree.binary.set(at("ok.pdf"), pdf("ok"));

    const report = await pushAll(configFor(c.corpus, c.tree), DIR);

    expect(report.ignored).toEqual(["notes.txt", "tool.exe"]);
    expect(report.failed).toEqual([
      { path: "fake.png", message: expect.stringContaining("PNG") },
    ]);
    expect(report.applied).toEqual([{ path: "ok.pdf", action: "created" }]);
    expect([...(await serverFiles(c.corpus)).keys()].sort()).toEqual([
      "a.png",
      "img/b.jpg",
      "ok.pdf",
    ]);
  });

  it("a dry run plans the file changes and sends nothing", async () => {
    const c = await checkout("edit");
    c.tree.binary.set(at("a.png"), png("changed"));
    c.tree.binary.set(at("new.png"), png("new"));
    c.tree.binary.delete(at("img/b.jpg"));
    const counted = countingFetch();

    const report = await pushAll(
      configFor(c.corpus, c.tree, counted.fetch),
      DIR,
      { dryRun: true },
    );

    expect(report.planned.map((a) => a.kind).sort()).toEqual([
      "file-remove",
      "file-replace",
      "file-upload",
    ]);
    expect(counted.calls).toEqual([]);
    const lines = formatPushReport(report, DIR).join("\n");
    expect(lines).toContain("upload  new.png");
    expect(lines).toContain("replace  a.png");
    expect(lines).toContain("delete  img/b.jpg");
  });
});

describe("push --all and images (suggest access)", () => {
  it("reports every binary change as needing edit access and sends none, while pages are still proposed", async () => {
    const c = await checkout("suggest");
    c.tree.binary.set(at("a.png"), png("changed"));
    c.tree.binary.set(at("new.png"), png("new"));
    c.tree.binary.delete(at("img/b.jpg"));
    c.tree.map.set(at("readme.md"), "# Readme, suggested\n");
    const counted = countingFetch();

    const report = await pushAll(
      configFor(c.corpus, c.tree, counted.fetch),
      DIR,
    );

    expect(counted.calls).toEqual([]);
    expect(report.skipped.map((s) => `${s.path}:${s.reason}`).sort()).toEqual([
      "a.png:binary-needs-edit",
      "img/b.jpg:removal-needs-edit",
      "new.png:binary-needs-edit",
    ]);
    expect(report.proposed.map((p) => p.path)).toEqual(["readme.md"]);
    expect(formatPushReport(report, DIR).join("\n")).toContain(
      "images and attachments cannot be proposed for review",
    );
    expect(await serverFiles(c.corpus)).toEqual(
      new Map([
        ["a.png", await hashOf(png("a"))],
        ["img/b.jpg", await hashOf(jpeg("b"))],
      ]),
    );
  });
});

describe("a server without files", () => {
  it("leaves images ignored, as before", async () => {
    const c = await checkout("edit");
    c.tree.binary.set(at("new.png"), png("new"));
    const old: FetchLike = (input, init) =>
      new URL(input).pathname.startsWith("/api/v1/files")
        ? Promise.resolve(new Response("404 Not Found", { status: 404 }))
        : SELF.fetch(input, init);

    const report = await pushAll(configFor(c.corpus, c.tree, old), DIR);

    // Every image is ignored (the tracked ones included), and the state keeps
    // what it tracked rather than reading the missing listing as deletions.
    expect(report.ignored).toEqual(["a.png", "img/b.jpg", "new.png"]);
    expect(report.applied).toEqual([]);
    expect(stateOf(c.tree).assets?.map((a) => a.path)).toEqual([
      "a.png",
      "img/b.jpg",
    ]);
  });
});

describe("a page edit still pushes with images around", () => {
  it("is unaffected by tracked images", async () => {
    const c = await checkout("edit");
    await edit(c.corpus, "readme", "# Readme, v2\n", 1);
    const report = await pullAll(configFor(c.corpus, c.tree), DIR);
    expect(report.updated.map((u) => u.path)).toEqual(["readme.md"]);
    expect(report.unchanged).toEqual(["a.png", "img/b.jpg"]);
  });
});
