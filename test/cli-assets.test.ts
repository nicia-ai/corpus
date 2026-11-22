import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ASSET_EXTENSIONS, MAX_ASSET_BYTES } from "../cli/asset-kinds";
import { containedRead } from "../cli/checkout-guard";
import { CliError, type FetchLike } from "../cli/core";
import { pullAll } from "../cli/sync";
import {
  parseState,
  serializeState,
  sha256HexOfBytes,
  STATE_FILE,
  type SyncState,
} from "../cli/sync-state";
import { ALLOWED_FILE_EXTENSIONS } from "../src/store/domain/file-kinds";
import { MAX_FILE_BYTES } from "../src/util";

import { memoryTree, type MemoryTree } from "./_cli-fixtures";
import { hashOf, jpeg, png } from "./_images";

// The CLI half of images and attachments that needs no server: the state file's
// compatibility in both directions, the allowlist's agreement with the server,
// and what `pull --all` does with a listing it must not trust. The server is a
// stub, so a hostile or broken listing can be served on purpose.

const DIR = "checkout";
const at = (path: string): string => `${DIR}/${path}`;
const IDENTITY = { projectId: "p1", slug: "c1" } as const;

// The state schema as the CLI shipped it before images: no `assets`. An old
// CLI parses with exactly this, so whatever the new CLI writes must pass it.
const PreviousStateSchema = z.object({
  version: z.literal(1),
  corpus: z.object({ projectId: z.string().min(1), slug: z.string().min(1) }),
  files: z.array(
    z.object({
      path: z.string(),
      slug: z.string().min(1),
      docVersion: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ),
  proposals: z.array(z.unknown()).optional(),
});

describe("the state file across CLI versions", () => {
  const WITH_ASSETS: SyncState = {
    version: 1,
    corpus: IDENTITY,
    files: [{ path: "a.md", slug: "a", docVersion: 1, sha256: "0".repeat(64) }],
    assets: [
      { path: "img/x.png", slug: "f1", sha256: "1".repeat(64), size: 9 },
    ],
  };

  it("is still version 1, and a CLI without images parses it, ignoring assets", () => {
    const written: unknown = JSON.parse(serializeState(WITH_ASSETS));
    expect(written).toMatchObject({ version: 1 });
    const parsedByPrevious = PreviousStateSchema.parse(written);
    expect(parsedByPrevious.files.map((f) => f.path)).toEqual(["a.md"]);
    expect(parsedByPrevious).not.toHaveProperty("assets");
  });

  it("is read by this CLI when written without assets, byte for byte", () => {
    const old = `${JSON.stringify(
      {
        version: 1,
        corpus: IDENTITY,
        files: [
          { path: "a.md", slug: "a", docVersion: 3, sha256: "2".repeat(64) },
        ],
      },
      null,
      2,
    )}\n`;
    const parsed = parseState(old, STATE_FILE);
    expect(parsed.assets).toBeUndefined();
    expect(serializeState(parsed)).toBe(old);
  });

  it("round-trips assets, sorted by path, and rejects an unsafe one", () => {
    const unsorted: SyncState = {
      ...WITH_ASSETS,
      assets: [
        { path: "z.png", slug: "f2", sha256: "3".repeat(64), size: 1 },
        { path: "b.png", slug: "f3", sha256: "4".repeat(64), size: 2 },
      ],
    };
    const parsed = parseState(serializeState(unsorted), STATE_FILE);
    expect(parsed.assets?.map((a) => a.path)).toEqual(["b.png", "z.png"]);
    const hostile = JSON.stringify({
      ...WITH_ASSETS,
      assets: [
        { path: "../x.png", slug: "f", sha256: "5".repeat(64), size: 1 },
      ],
    });
    expect(() => parseState(hostile, STATE_FILE)).toThrow(CliError);
  });
});

describe("the CLI's allowlist", () => {
  it("is the server's: same extensions, same size cap", () => {
    expect([...ASSET_EXTENSIONS].sort()).toEqual(
      [...ALLOWED_FILE_EXTENSIONS].sort(),
    );
    expect(MAX_ASSET_BYTES).toBe(MAX_FILE_BYTES);
  });
});

type Listed = Readonly<{
  slug: string;
  path: string;
  bytes: Uint8Array<ArrayBuffer>;
  // What the listing claims; defaults to the real hash.
  sha256?: string;
}>;

type StubServer = Readonly<{
  fetch: FetchLike;
  downloads: string[];
  // Replace what the server holds.
  setFiles: (files: readonly Listed[]) => void;
}>;

// A server with no documents and the given files. `filesRoute: false` is an
// old server: the unknown route answers 404.
function stubServer(initial: readonly Listed[], filesRoute = true): StubServer {
  let held = [...initial];
  const downloads: string[] = [];
  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  const fetch: FetchLike = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/api/v1/docs") {
      return json({ corpus: IDENTITY, grant: "edit", documents: [] });
    }
    if (!filesRoute) return new Response("404 Not Found", { status: 404 });
    if (url.pathname === "/api/v1/files") {
      return json({
        files: await Promise.all(
          held.map(async (f) => ({
            slug: f.slug,
            path: f.path,
            sha256: f.sha256 ?? (await hashOf(f.bytes)),
            size: f.bytes.byteLength,
            contentType: "image/png",
          })),
        ),
      });
    }
    const slug = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    downloads.push(slug);
    const file = held.find((f) => f.slug === slug);
    return file === undefined
      ? new Response("{}", { status: 404 })
      : new Response(file.bytes);
  };
  return {
    fetch,
    downloads,
    setFiles: (files) => {
      held = [...files];
    },
  };
}

const configFor = (server: StubServer, tree: MemoryTree) =>
  ({
    baseUrl: "https://example.com",
    apiKey: "k",
    fetch: server.fetch,
    files: tree,
  }) as const;

function stateOf(tree: MemoryTree): SyncState {
  return parseState(tree.map.get(at(STATE_FILE)) ?? "", STATE_FILE);
}

describe("pull --all writes images and attachments", () => {
  it("downloads them, verifies each, and records them in the state", async () => {
    const server = stubServer([
      { slug: "f1", path: "img/a.png", bytes: png("a") },
      { slug: "f2", path: "doc/b.jpg", bytes: jpeg("b") },
    ]);
    const tree = memoryTree();
    const report = await pullAll(configFor(server, tree), DIR);

    expect(report.added.map((c) => c.path)).toEqual(["doc/b.jpg", "img/a.png"]);
    expect(tree.binary.get(at("img/a.png"))).toEqual(png("a"));
    expect(tree.binary.get(at("doc/b.jpg"))).toEqual(jpeg("b"));
    expect(stateOf(tree).assets).toEqual([
      {
        path: "doc/b.jpg",
        slug: "f2",
        sha256: await hashOf(jpeg("b")),
        size: jpeg("b").byteLength,
      },
      {
        path: "img/a.png",
        slug: "f1",
        sha256: await hashOf(png("a")),
        size: png("a").byteLength,
      },
    ]);
  });

  it("skips a file whose hash already matches: no download, no write", async () => {
    const server = stubServer([{ slug: "f1", path: "a.png", bytes: png("a") }]);
    const tree = memoryTree();
    await pullAll(configFor(server, tree), DIR);
    const downloadsBefore = server.downloads.length;
    const writesBefore = tree.writes.length;

    const again = await pullAll(configFor(server, tree), DIR);

    expect(server.downloads.length).toBe(downloadsBefore);
    expect(tree.writes.length).toBe(writesBefore);
    expect(again.unchanged).toEqual(["a.png"]);
  });

  it("downloads only what changed, and restores one deleted locally", async () => {
    const server = stubServer([
      { slug: "f1", path: "a.png", bytes: png("a") },
      { slug: "f2", path: "b.png", bytes: png("b") },
    ]);
    const tree = memoryTree();
    await pullAll(configFor(server, tree), DIR);
    server.downloads.length = 0;
    server.setFiles([
      { slug: "f1", path: "a.png", bytes: png("a2") },
      { slug: "f2", path: "b.png", bytes: png("b") },
    ]);
    tree.binary.delete(at("b.png"));

    await pullAll(configFor(server, tree), DIR);

    expect([...server.downloads].sort()).toEqual(["f1", "f2"]);
    expect(tree.binary.get(at("a.png"))).toEqual(png("a2"));
    expect(tree.binary.get(at("b.png"))).toEqual(png("b"));
  });

  it("follows a move and removes what is gone upstream", async () => {
    const server = stubServer([
      { slug: "f1", path: "a.png", bytes: png("a") },
      { slug: "f2", path: "b.png", bytes: png("b") },
    ]);
    const tree = memoryTree();
    await pullAll(configFor(server, tree), DIR);
    server.setFiles([{ slug: "f1", path: "img/a.png", bytes: png("a") }]);

    const report = await pullAll(configFor(server, tree), DIR);

    expect(tree.binary.has(at("a.png"))).toBe(false);
    expect(tree.binary.has(at("b.png"))).toBe(false);
    expect(tree.binary.get(at("img/a.png"))).toEqual(png("a"));
    expect(report.removed).toContain("b.png");
    expect(stateOf(tree).assets?.map((a) => a.path)).toEqual(["img/a.png"]);
  });
});

describe("pull --all and a file edited locally", () => {
  async function pulledThenEdited(): Promise<
    Readonly<{ server: StubServer; tree: MemoryTree }>
  > {
    const server = stubServer([{ slug: "f1", path: "a.png", bytes: png("a") }]);
    const tree = memoryTree();
    await pullAll(configFor(server, tree), DIR);
    tree.binary.set(at("a.png"), png("mine"));
    return { server, tree };
  }

  it("keeps it when upstream did not change (and says so)", async () => {
    const { server, tree } = await pulledThenEdited();
    const report = await pullAll(configFor(server, tree), DIR);
    expect(report.keptLocal).toEqual(["a.png"]);
    expect(tree.binary.get(at("a.png"))).toEqual(png("mine"));
  });

  it("refuses to overwrite it when upstream changed, until --overwrite", async () => {
    const { server, tree } = await pulledThenEdited();
    server.setFiles([{ slug: "f1", path: "a.png", bytes: png("theirs") }]);
    server.downloads.length = 0;

    const report = await pullAll(configFor(server, tree), DIR);
    expect(report.conflicts).toEqual([
      { slug: "f1", path: "a.png", reason: "edited-locally" },
    ]);
    expect(tree.binary.get(at("a.png"))).toEqual(png("mine"));
    expect(server.downloads).toEqual([]);

    await pullAll(configFor(server, tree), DIR, { overwrite: true });
    expect(tree.binary.get(at("a.png"))).toEqual(png("theirs"));
  });

  it("refuses to delete it when it was removed upstream", async () => {
    const { server, tree } = await pulledThenEdited();
    server.setFiles([]);
    const report = await pullAll(configFor(server, tree), DIR);
    expect(report.conflicts).toEqual([
      { slug: "f1", path: "a.png", reason: "deleted-upstream" },
    ]);
    expect(tree.binary.get(at("a.png"))).toEqual(png("mine"));
  });

  it("will not write over an untracked file already at the path", async () => {
    const server = stubServer([{ slug: "f1", path: "a.png", bytes: png("a") }]);
    const tree = memoryTree();
    tree.binary.set(at("a.png"), png("someone else's"));
    const report = await pullAll(configFor(server, tree), DIR);
    expect(report.conflicts).toEqual([
      { slug: "f1", path: "a.png", reason: "untracked-in-the-way" },
    ]);
    expect(tree.binary.get(at("a.png"))).toEqual(png("someone else's"));
  });
});

describe("pull --all and a listing it must not trust", () => {
  it.each([
    ["../escape.png", "empty, '.' or '..' segment"],
    ["/etc/x.png", "absolute path"],
    ["C:/x.png", "absolute path"],
    ["img\\x.png", "backslash in path"],
    [".git/hooks/x.png", "'.git' segment"],
    ["a/./x.png", "empty, '.' or '..' segment"],
  ])("refuses %s before writing anything", async (path, problem) => {
    const server = stubServer([
      { slug: "ok", path: "fine.png", bytes: png("ok") },
      { slug: "bad", path, bytes: png("bad") },
    ]);
    const tree = memoryTree();
    const error = await pullAll(configFor(server, tree), DIR).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).kind).toBe("unsafe-path");
    expect((error as CliError).message).toContain(problem);
    expect(tree.writes).toEqual([]);
    expect(server.downloads).toEqual([]);
  });

  it("refuses two files that differ only by case, or by Unicode form", async () => {
    for (const [a, b] of [
      ["Photo.png", "photo.png"],
      ["caf\u00e9.png", "cafe\u0301.png"],
    ] as const) {
      const server = stubServer([
        { slug: "1", path: a, bytes: png("1") },
        { slug: "2", path: b, bytes: png("2") },
      ]);
      const tree = memoryTree();
      const error = await pullAll(configFor(server, tree), DIR).catch(
        (e: unknown) => e,
      );
      expect((error as CliError).kind).toBe("unsafe-path");
      expect(tree.writes).toEqual([]);
    }
  });

  it("never accepts bytes that do not hash to what the listing promised", async () => {
    const server = stubServer([
      {
        slug: "f1",
        path: "a.png",
        bytes: png("tampered"),
        sha256: await hashOf(png("promised")),
      },
    ]);
    const tree = memoryTree();
    const error = await pullAll(configFor(server, tree), DIR).catch(
      (e: unknown) => e,
    );
    expect((error as CliError).kind).toBe("mismatch");
    expect(tree.binary.size).toBe(0);
    expect(stateOf(tree).assets).toBeUndefined();
  });

  it("records what it finished when a later download fails", async () => {
    const server = stubServer([
      { slug: "f1", path: "a.png", bytes: png("a") },
      {
        slug: "f2",
        path: "b.png",
        bytes: png("tampered"),
        sha256: await hashOf(png("promised")),
      },
    ]);
    const tree = memoryTree();
    await expect(pullAll(configFor(server, tree), DIR)).rejects.toThrow(
      CliError,
    );
    expect(tree.binary.get(at("a.png"))).toEqual(png("a"));
    expect(stateOf(tree).assets?.map((a) => a.path)).toEqual(["a.png"]);
  });

  it("keeps what it tracks when the server predates files (404), and deletes nothing", async () => {
    const server = stubServer([{ slug: "f1", path: "a.png", bytes: png("a") }]);
    const tree = memoryTree();
    await pullAll(configFor(server, tree), DIR);
    const before = tree.map.get(at(STATE_FILE));

    const old = stubServer([], false);
    const report = await pullAll(configFor(old, tree), DIR);

    expect(report.removed).toEqual([]);
    expect(tree.binary.get(at("a.png"))).toEqual(png("a"));
    expect(tree.map.get(at(STATE_FILE))).toBe(before);
  });
});

describe("the checkout guard for bytes", () => {
  it("refuses to read a file that resolves outside the checkout", async () => {
    const read = containedRead<Uint8Array>(
      "/work/checkout",
      {
        realPath: (path) =>
          Promise.resolve(
            path === "/work/checkout" ? path : "/home/me/.ssh/id_rsa",
          ),
        isRegularFile: () => Promise.resolve(true),
      },
      () => Promise.resolve(new Uint8Array([1])),
    );
    const error = await read("/work/checkout/a.png").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).kind).toBe("unsafe-path");
  });

  it("reads one inside, and treats a missing path as absent", async () => {
    const files = new Map([["/work/checkout/a.png", new Uint8Array([7])]]);
    const read = containedRead<Uint8Array>(
      "/work/checkout",
      {
        realPath: (path) =>
          Promise.resolve(
            files.has(path) || path === "/work/checkout" ? path : undefined,
          ),
        isRegularFile: () => Promise.resolve(true),
      },
      (path) => Promise.resolve(files.get(path)),
    );
    expect(await read("/work/checkout/a.png")).toEqual(new Uint8Array([7]));
    expect(await read("/work/checkout/gone.png")).toBeUndefined();
  });
});

it("hashes bytes the way the server does", async () => {
  expect(await sha256HexOfBytes(png("x"))).toBe(await hashOf(png("x")));
});
