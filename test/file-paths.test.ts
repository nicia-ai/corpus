import { describe, expect, it } from "vitest";

import { asDocumentSlug, asFolderSlug, type CorpusSlug } from "../src/ids";
import type { AttachFileResult } from "../src/project-store/commands/files";
import { formatOfExtension } from "../src/store/domain/file-kinds";

import { colSlug, freshStore } from "./_helpers";

// A stored file is a node in the same path namespace as documents and
// folders: a name is taken once, wherever it is taken; a folder carries its
// files when it is renamed or moved (so relative links keep resolving); and a
// delete cascades. These run against the Durable Object directly: the bytes
// (R2) are the transport's half and are covered in test/files/.

const BY = "tester";
const CORPUS = colSlug("handbook");
function pngFormat() {
  const format = formatOfExtension("png");
  if (format === undefined) throw new Error("the png format must exist");
  return format;
}

type Store = ReturnType<typeof freshStore>;

async function project(): Promise<Store> {
  const store = freshStore("filepaths");
  await store.createCorpus({ slug: CORPUS, name: "Handbook", changedBy: BY });
  return store;
}

async function page(
  store: Store,
  path: string,
  markdown = "# Page\n",
  corpus: CorpusSlug = CORPUS,
) {
  const r = await store.importDocumentAtPath({
    corpusSlug: corpus,
    path,
    markdown,
    changedBy: BY,
  });
  if (!r.ok) throw new Error(`fixture: could not write ${path}`);
  return asDocumentSlug(r.slug);
}

function attach(
  store: Store,
  documentSlug: ReturnType<typeof asDocumentSlug>,
  name: string | undefined,
  seed: string,
  size = 10,
): Promise<AttachFileResult> {
  return store.attachFile({
    documentSlug,
    name,
    contentHash: seed.padEnd(64, "0"),
    size,
    format: pngFormat(),
    changedBy: BY,
  });
}

async function attached(
  ...args: Parameters<typeof attach>
): Promise<Extract<AttachFileResult, { ok: true }>> {
  const r = await attach(...args);
  if (!r.ok) throw new Error(`fixture: attach failed: ${r.reason}`);
  return r;
}

async function folderSlug(store: Store, name: string) {
  const f = (await store.listFolders()).find((x) => x.name === name);
  if (f === undefined) throw new Error(`fixture: no folder ${name}`);
  return asFolderSlug(f.slug);
}

async function assetsOf(store: Store, slug: ReturnType<typeof asDocumentSlug>) {
  return (await store.documentReviewSnapshot(slug)).assets;
}

describe("a file shares its folder's path namespace", () => {
  it("cannot be given the name of a page beside it; takes the next free one", async () => {
    const store = await project();
    const p = await page(store, "guide/page.md");
    await page(store, "guide/logo.png", "# a page that happens to end in .png");
    const r = await attached(store, p, "logo.png", "a1");
    expect(r.file.name).toBe("logo-2.png");
  });

  it("blocks a page and a folder from taking a file's name", async () => {
    const store = await project();
    const p = await page(store, "guide/page.md");
    await attached(store, p, "taken.png", "b1");

    // A new page at the file's path.
    const doc = await store.importDocumentAtPath({
      corpusSlug: CORPUS,
      path: "guide/taken.png",
      markdown: "x",
      changedBy: BY,
    });
    expect(doc).toEqual({ ok: false, reason: "segment-collision" });

    // A new folder with the file's name, in the same folder.
    const guide = await folderSlug(store, "guide");
    const folder = await store.createFolder("taken.png", {
      corpusSlug: CORPUS,
      folderSlug: guide,
    });
    expect(folder.ok).toBe(false);
  });

  it("is refused to a page's filename rename that would collide", async () => {
    const store = await project();
    const p = await page(store, "guide/page.md");
    const other = await page(store, "guide/other.md");
    await attached(store, p, "pic.png", "c1");
    const renamed = await store.renameFilename({
      slug: other,
      filename: "pic.png",
      changedBy: BY,
    });
    expect(renamed.ok).toBe(false);
  });

  it("lets a deleted file's name be used again", async () => {
    const store = await project();
    const p = await page(store, "guide/page.md");
    const sub = await page(store, "guide/sub/inner.md");
    await attached(store, sub, "gone.png", "d1");
    const subFolder = await folderSlug(store, "sub");
    await store.deleteFolder(subFolder, BY);
    // The folder (and its file) are gone; a same-named file elsewhere is fine.
    const again = await attached(store, p, "gone.png", "d2");
    expect(again.file.name).toBe("gone.png");
  });
});

describe("relative image links resolve against the page's folder", () => {
  const markdown = "# Setup\n\n![shot](./shot.png)\n\n![up](../top.png)\n";

  it("resolves a sibling and a parent-relative target, keyed as written", async () => {
    const store = await project();
    const top = await page(store, "top.md");
    const p = await page(store, "guide/setup.md", markdown);
    await attached(store, p, "shot.png", "e1");
    await attached(store, top, "top.png", "e2");

    const assets = await assetsOf(store, p);

    expect(Object.keys(assets).sort()).toEqual(["../top.png", "./shot.png"]);
    expect(assets["./shot.png"]?.name).toBe("shot.png");
    expect(assets["../top.png"]?.contentType).toBe("image/png");
    expect(assets["./shot.png"]?.url).toContain(`/${"e1".padEnd(64, "0")}`);
  });

  it("is not an asset when no file answers to the target", async () => {
    const store = await project();
    const p = await page(store, "guide/setup.md", markdown);
    expect(await assetsOf(store, p)).toEqual({});
  });

  it("keeps resolving after the folder is renamed", async () => {
    const store = await project();
    const p = await page(store, "guide/setup.md", markdown);
    await attached(store, p, "shot.png", "f1");
    const guide = await folderSlug(store, "guide");

    const renamed = await store.renameFolder(guide, "handbook", BY);
    expect(renamed.ok).toBe(true);

    expect(Object.keys(await assetsOf(store, p))).toEqual(["./shot.png"]);
  });

  it("keeps resolving after the folder is moved to another folder", async () => {
    const store = await project();
    const p = await page(store, "guide/setup.md", markdown);
    await page(store, "archive/old.md");
    await attached(store, p, "shot.png", "g1");
    const guide = await folderSlug(store, "guide");
    const archive = await folderSlug(store, "archive");

    const moved = await store.moveFolder(
      guide,
      { corpusSlug: CORPUS, folderSlug: archive },
      BY,
    );
    expect(moved.ok).toBe(true);

    const after = await assetsOf(store, p);
    expect(after["./shot.png"]?.name).toBe("shot.png");
  });

  it("does not follow a page moved away from its images (the bytes are never rewritten)", async () => {
    const store = await project();
    const p = await page(store, "guide/setup.md", markdown);
    await attached(store, p, "shot.png", "h1");
    await store.moveDocumentToPath(p, CORPUS, "elsewhere/setup.md", BY);
    // The link text is exactly as written, so it now finds nothing.
    expect(await assetsOf(store, p)).toEqual({});
    expect((await store.getDocument(p))?.markdown).toBe(markdown);
  });

  it("ignores a target without an allowlisted extension", async () => {
    const store = await project();
    const p = await page(store, "guide/setup.md", "[a](./notes.txt) ![](./x)");
    expect(await assetsOf(store, p)).toEqual({});
  });
});

describe("deleting a folder or corpus", () => {
  it("soft-deletes the files in it and records file.deleted", async () => {
    const store = await project();
    const p = await page(store, "guide/setup.md");
    await attached(store, p, "shot.png", "i1");
    const hash = "i1".padEnd(64, "0");
    expect(await store.fileByHash(hash)).toBeDefined();

    const guide = await folderSlug(store, "guide");
    const result = await store.deleteFolder(guide, BY);

    expect(result.ok).toBe(true);
    expect(await store.fileByHash(hash)).toBeUndefined();
    expect(await store.liveFileCount()).toBe(0);
    // The node is retained until reaped, so the bytes stay referenced.
    expect(await store.referencedFileHashes()).toEqual([hash]);
    const events = (await store.recentChanges(20)).map((e) => e.eventType);
    expect(events).toContain("file.created");
    expect(events).toContain("file.deleted");
  });

  it("soft-deletes a deleted corpus's files and carries them with 'keep as drafts'", async () => {
    const store = await project();
    const keepSlug = colSlug("keeper");
    await store.createCorpus({ slug: keepSlug, name: "Keeper", changedBy: BY });
    const kept = await page(store, "note.md", "# n", keepSlug);
    const gone = await page(store, "other.md", "# o");
    await attached(store, kept, "kept.png", "j1");
    await attached(store, gone, "gone.png", "j2");

    const keepResult = await store.deleteCorpus({
      slug: keepSlug,
      pages: "move-to-default",
      changedBy: BY,
    });
    expect(keepResult.ok).toBe(true);
    expect(await store.fileByHash("j1".padEnd(64, "0"))).toBeDefined();

    const dropResult = await store.deleteCorpus({
      slug: CORPUS,
      pages: "archive",
      changedBy: BY,
    });
    expect(dropResult.ok).toBe(true);
    expect(await store.fileByHash("j2".padEnd(64, "0"))).toBeUndefined();
    expect(await store.fileByHash("j1".padEnd(64, "0"))).toBeDefined();
  });
});

describe("the retention reaper", () => {
  const DAY = 86_400_000;

  it("removes a soft-deleted file past its window and never touches a head file", async () => {
    const store = await project();
    const doomed = await page(store, "old/page.md");
    const live = await page(store, "live/page.md");
    await attached(store, doomed, "old.png", "k1");
    await attached(store, live, "live.png", "k2");
    await store.deleteFolder(await folderSlug(store, "old"), BY);

    const early = await store.reapExpired({ fileDays: 7 }, Date.now() + DAY);
    expect(early.filesDeleted).toBe(0);
    expect(await store.referencedFileHashes()).toHaveLength(2);

    const late = await store.reapExpired({ fileDays: 7 }, Date.now() + 9 * DAY);
    expect(late.filesDeleted).toBe(1);
    expect(await store.referencedFileHashes()).toEqual(["k2".padEnd(64, "0")]);
    // Absent window = forever: nothing is reaped however late.
    const never = await store.reapExpired({}, Date.now() + 999 * DAY);
    expect(never.filesDeleted).toBe(0);
    expect(await store.fileByHash("k2".padEnd(64, "0"))).toBeDefined();
  });
});

describe("the bundle", () => {
  it("leaves files out, and reports how many", async () => {
    const store = await project();
    const p = await page(store, "guide/setup.md", "![](./shot.png)");
    await attached(store, p, "shot.png", "l1");

    const bundle = await store.exportBundle({
      organization: "acme",
      project: "default",
    });
    expect(JSON.stringify(bundle)).not.toContain("l1".padEnd(64, "0"));
    expect(JSON.stringify(bundle)).not.toContain('"filename":"shot.png"');
    // The link text is canonical markdown and travels untouched (dangling).
    expect(bundle.documents["guide-setup"]?.md).toBe("![](./shot.png)");
    expect(await store.liveFileCount()).toBe(1);
  });
});
