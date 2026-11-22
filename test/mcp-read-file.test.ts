import { describe, expect, it } from "vitest";

import {
  asCallerRef,
  asDocumentSlug,
  asProjectId,
  type ProjectId,
} from "../src/ids";
import { handleMcp, RpcSchema } from "../src/mcp";
import { FILES_DISABLED_TEXT, MCP_FILE_MAX_BYTES } from "../src/mcp/files";
import { ERR, SERVER_INSTRUCTIONS, TOOLS } from "../src/mcp/protocol";
import { scopedExecutor } from "../src/scoped-executor";
import { formatOfExtension } from "../src/store/domain/file-kinds";
import {
  fileObjectKey,
  type ObjectStore,
} from "../src/store/repos/object-store";
import { sha256Hex } from "../src/util";

import { colSlug, freshStore } from "./_helpers";

// read_file / list_files, driven the way respondMcp drives them: a
// scopedExecutor bound to one Corpus over a real ProjectStore, with an
// in-memory ObjectStore standing in for R2 (the port is the seam; the R2
// adapter has its own tests under test/files).

const AGENT = asCallerRef("apikey:agent-a");
const PROJECT: ProjectId = asProjectId("test-project");
const LOCATION = { baseUrl: "http://localhost:8787", projectId: PROJECT };

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 250, 251, 252, 255,
]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7]);
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"/>',
);
const PDF = new TextEncoder().encode("%PDF-1.4\nx\n%%EOF");

type RpcResponse = Readonly<{
  result?: {
    isError?: boolean;
    content?: {
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
    }[];
  };
  error?: { code: number; message: string };
}>;

function memoryObjects(): ObjectStore & { keys: () => string[] } {
  const held = new Map<string, Uint8Array>();
  return {
    put: (key, bytes) => {
      held.set(key, bytes);
      return Promise.resolve();
    },
    get: (key) => {
      const bytes = held.get(key);
      return Promise.resolve(
        bytes === undefined
          ? undefined
          : {
              size: bytes.byteLength,
              body:
                new Response(bytes as Uint8Array<ArrayBuffer>).body ??
                new ReadableStream(),
            },
      );
    },
    head: () => Promise.resolve(undefined),
    list: () => Promise.resolve({ objects: [], cursor: undefined }),
    delete: (deleted) => {
      for (const key of deleted) held.delete(key);
      return Promise.resolve();
    },
    keys: () => [...held.keys()],
  };
}

type Fixture = Readonly<{
  store: ReturnType<typeof freshStore>;
  objects: ReturnType<typeof memoryObjects>;
  exec: ReturnType<typeof scopedExecutor>;
  execWithout: ReturnType<typeof scopedExecutor>;
}>;

// Corpus A: guide/page.md with guide/diagram.png, guide/photo.jpg,
// guide/logo.svg, guide/spec.pdf, and top.md at the root. Corpus B: its own
// page and secret.png. The executor is bound to A.
async function setup(): Promise<Fixture> {
  const store = freshStore("mcpfile");
  const objects = memoryObjects();
  for (const [slug, name] of [
    ["col-a", "A"],
    ["col-b", "B"],
  ] as const) {
    await store.createCorpus({ slug: colSlug(slug), name, changedBy: "alice" });
  }
  const pageA = await store.importDocumentAtPath({
    corpusSlug: colSlug("col-a"),
    path: "guide/page.md",
    markdown: "# A\n\n![d](./diagram.png)\n",
    changedBy: "alice",
  });
  await store.importDocumentAtPath({
    corpusSlug: colSlug("col-a"),
    path: "top.md",
    markdown: "# Top\n",
    changedBy: "alice",
  });
  const pageB = await store.importDocumentAtPath({
    corpusSlug: colSlug("col-b"),
    path: "other/page.md",
    markdown: "# B\n",
    changedBy: "bob",
  });
  if (!pageA.ok || !pageB.ok) throw new Error("fixture: pages not created");

  const attach = async (
    page: typeof pageA,
    name: string,
    bytes: Uint8Array,
    declaredSize = bytes.byteLength,
  ): Promise<void> => {
    if (!page.ok) throw new Error("fixture");
    const format = formatOfExtension(name.split(".").pop() ?? "");
    if (format === undefined) throw new Error(`fixture: no format for ${name}`);
    const contentHash = await sha256Hex(bytes as Uint8Array<ArrayBuffer>);
    await objects.put(fileObjectKey(PROJECT, contentHash), bytes);
    const res = await store.attachFile({
      documentSlug: asDocumentSlug(page.slug),
      name,
      contentHash,
      size: declaredSize,
      format,
      changedBy: "alice",
    });
    if (!res.ok) throw new Error(`fixture: attach ${name} failed`);
  };
  await attach(pageA, "diagram.png", PNG);
  await attach(pageA, "photo.jpg", JPEG);
  await attach(pageA, "logo.svg", SVG);
  await attach(pageA, "spec.pdf", PDF);
  await attach(pageB, "secret.png", new Uint8Array([...PNG, 77]));

  const members = (await store.corpusMembers(colSlug("col-a"))) ?? [];
  const bind = (withObjects: boolean) =>
    scopedExecutor(
      store,
      colSlug("col-a"),
      members,
      AGENT,
      withObjects ? { ...LOCATION, objects } : LOCATION,
    );
  return { store, objects, exec: bind(true), execWithout: bind(false) };
}

function call(
  exec: ReturnType<typeof scopedExecutor>,
  name: string,
  args: Record<string, unknown> = {},
): Promise<RpcResponse> {
  return handleMcp(
    RpcSchema.parse({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
    exec,
  ) as Promise<RpcResponse>;
}

function base64Of(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

describe("read_file", () => {
  it("returns a PNG as an image block that round-trips byte for byte", async () => {
    const { exec } = await setup();
    const res = await call(exec, "read_file", { path: "guide/diagram.png" });
    expect(res.result?.content).toEqual([
      { type: "image", data: base64Of(PNG), mimeType: "image/png" },
    ]);
  });

  it("returns a JPEG with its own mime type", async () => {
    const { exec } = await setup();
    const res = await call(exec, "read_file", { path: "guide/photo.jpg" });
    expect(res.result?.content).toEqual([
      { type: "image", data: base64Of(JPEG), mimeType: "image/jpeg" },
    ]);
  });

  it("resolves a `src` exactly as written in a page, relative to that page", async () => {
    const { exec } = await setup();
    for (const document of ["guide/page.md"]) {
      const res = await call(exec, "read_file", {
        path: "./diagram.png",
        document,
      });
      expect(res.result?.content?.[0]).toMatchObject({
        type: "image",
        data: base64Of(PNG),
      });
    }
  });

  it("accepts the page by slug and resolves `../` within the Corpus", async () => {
    const { exec } = await setup();
    const slug = (await exec.listDocuments()).find(
      (d) => d.path === "guide/page.md",
    )?.slug;
    expect(slug).toBeDefined();
    const bySlug = await call(exec, "read_file", {
      path: "diagram.png",
      document: slug,
    });
    expect(bySlug.result?.content?.[0]?.type).toBe("image");
    const upAndBack = await call(exec, "read_file", {
      path: "../guide/photo.jpg",
      document: "guide/page.md",
    });
    expect(upAndBack.result?.content?.[0]?.mimeType).toBe("image/jpeg");
  });

  it("does not resolve a bare name against the Corpus root", async () => {
    const { exec } = await setup();
    const res = await call(exec, "read_file", { path: "diagram.png" });
    expect(res.error?.code).toBe(ERR.NOT_FOUND);
  });

  it("refuses a path that climbs out of the Corpus", async () => {
    const { exec } = await setup();
    for (const args of [
      { path: "../secret.png" },
      { path: "../../other/secret.png" },
      { path: "../other/secret.png", document: "top.md" },
      { path: "../../secret.png", document: "guide/page.md" },
    ]) {
      const res = await call(exec, "read_file", args);
      expect(res.error?.code).toBe(ERR.NOT_FOUND);
      expect(res.result).toBeUndefined();
    }
  });

  it("never serves another corpus's file, by path or by page", async () => {
    const { exec, store } = await setup();
    const other = (await store.listFiles()).find(
      (f) => f.corpusSlug === colSlug("col-b"),
    );
    expect(other?.path).toBe("other/secret.png");
    for (const args of [
      { path: "other/secret.png" },
      { path: "/other/secret.png" },
      { path: "secret.png", document: "other/page.md" },
      { path: "./secret.png", document: "page" },
    ]) {
      const res = await call(exec, "read_file", args);
      expect(res.error?.code).toBe(ERR.NOT_FOUND);
      expect(JSON.stringify(res)).not.toContain(
        base64Of(new Uint8Array([...PNG, 77])),
      );
    }
  });

  it("returns metadata only for SVG and PDF, never the bytes", async () => {
    const { exec } = await setup();
    for (const [path, contentType, size] of [
      ["guide/logo.svg", "image/svg+xml", SVG.byteLength],
      ["guide/spec.pdf", "application/pdf", PDF.byteLength],
    ] as const) {
      const res = await call(exec, "read_file", { path });
      const content = res.result?.content ?? [];
      expect(content).toHaveLength(1);
      expect(content[0]?.type).toBe("text");
      expect(JSON.parse(content[0]?.text ?? "{}")).toMatchObject({
        name: path.split("/").pop(),
        path,
        size,
        contentType,
      });
    }
  });

  it("refuses a file over the cap with a text error naming its size", async () => {
    const store = freshStore("mcpfilecap");
    const objects = memoryObjects();
    await store.createCorpus({
      slug: colSlug("col-a"),
      name: "A",
      changedBy: "alice",
    });
    const page = await store.importDocumentAtPath({
      corpusSlug: colSlug("col-a"),
      path: "page.md",
      markdown: "# A\n",
      changedBy: "alice",
    });
    if (!page.ok) throw new Error("fixture");
    const big = MCP_FILE_MAX_BYTES + 1;
    const format = formatOfExtension("png");
    if (format === undefined) throw new Error("fixture");
    await store.attachFile({
      documentSlug: asDocumentSlug(page.slug),
      name: "huge.png",
      contentHash: "a".repeat(64),
      size: big,
      format,
      changedBy: "alice",
    });
    const members = (await store.corpusMembers(colSlug("col-a"))) ?? [];
    const exec = scopedExecutor(store, colSlug("col-a"), members, AGENT, {
      ...LOCATION,
      objects,
    });
    const res = await call(exec, "read_file", { path: "huge.png" });
    expect(res.result?.isError).toBe(true);
    const text = res.result?.content?.[0]?.text ?? "";
    expect(res.result?.content?.[0]?.type).toBe("text");
    expect(text).toContain(String(big));
    expect(text).toContain("5.0 MiB");
  });

  it("answers 'files are not enabled' when the deployment has no storage", async () => {
    const { execWithout } = await setup();
    const res = await call(execWithout, "read_file", {
      path: "guide/diagram.png",
    });
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content?.[0]?.text).toBe(FILES_DISABLED_TEXT);
    expect(res.error).toBeUndefined();
  });

  it("needs a path", async () => {
    const { exec } = await setup();
    const res = await call(exec, "read_file", {});
    expect(res.error?.code).toBe(ERR.INVALID_PARAMS);
  });

  it("reports missing bytes as an error, not a crash", async () => {
    const { exec, objects } = await setup();
    const hash = await sha256Hex(PNG);
    await objects.delete([fileObjectKey(PROJECT, hash)]);
    const res = await call(exec, "read_file", {
      path: "./diagram.png",
      document: "guide/page.md",
    });
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content?.[0]?.text).toContain("missing from storage");
  });
});

describe("list_files", () => {
  it("lists only the bound Corpus's files, with path, size and type", async () => {
    const { exec } = await setup();
    const res = await call(exec, "list_files");
    const files = JSON.parse(res.result?.content?.[0]?.text ?? "[]") as unknown;
    expect(files).toEqual([
      {
        path: "guide/diagram.png",
        size: PNG.byteLength,
        contentType: "image/png",
      },
      {
        path: "guide/logo.svg",
        size: SVG.byteLength,
        contentType: "image/svg+xml",
      },
      {
        path: "guide/photo.jpg",
        size: JPEG.byteLength,
        contentType: "image/jpeg",
      },
      {
        path: "guide/spec.pdf",
        size: PDF.byteLength,
        contentType: "application/pdf",
      },
    ]);
  });

  it("leaves list_documents untouched: no files in it", async () => {
    const { exec } = await setup();
    const res = await call(exec, "list_documents");
    const docs = JSON.parse(res.result?.content?.[0]?.text ?? "[]") as {
      path: string;
    }[];
    expect(docs.map((d) => d.path).sort()).toEqual(["guide/page.md", "top.md"]);
  });
});

describe("advertising", () => {
  it("lists both tools and mentions them in the server instructions", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain("list_files");
    expect(names).toContain("read_file");
    expect(SERVER_INSTRUCTIONS).toContain("read_file");
    expect(SERVER_INSTRUCTIONS).toContain("list_files");
  });
});
