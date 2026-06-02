import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { asFolderSlug } from "../src/ids";
import { findAll, setFindPageSizeForTest } from "../src/store/repos/paginate";

import { colSlug, docSlug, freshStore } from "./_helpers";

const DAY = 86_400_000;

// — findAll loop (pure) ————————————————————————————————————————————
// The loop is the whole fix: a cap silently truncates, this pages until a
// short batch. These cases pin the boundary behavior a regression would break.
describe("findAll (exhaustive offset paging)", () => {
  function pager(items: readonly number[]): {
    windows: { limit: number; offset: number }[];
    page: (w: { limit: number; offset: number }) => Promise<readonly number[]>;
  } {
    const windows: { limit: number; offset: number }[] = [];
    return {
      windows,
      page: ({ limit, offset }) => {
        windows.push({ limit, offset });
        return Promise.resolve(items.slice(offset, offset + limit));
      },
    };
  }

  it("returns an empty set in one (empty) page", async () => {
    const restore = setFindPageSizeForTest(3);
    try {
      const { windows, page } = pager([]);
      expect(await findAll(page)).toEqual([]);
      expect(windows).toEqual([{ limit: 3, offset: 0 }]);
    } finally {
      restore();
    }
  });

  it("returns a single short page without a second request", async () => {
    const restore = setFindPageSizeForTest(3);
    try {
      const { windows, page } = pager([1, 2]);
      expect(await findAll(page)).toEqual([1, 2]);
      expect(windows).toEqual([{ limit: 3, offset: 0 }]);
    } finally {
      restore();
    }
  });

  it("crosses pages, concatenating in offset order", async () => {
    const restore = setFindPageSizeForTest(2);
    try {
      const { windows, page } = pager([1, 2, 3, 4, 5]);
      expect(await findAll(page)).toEqual([1, 2, 3, 4, 5]);
      expect(windows).toEqual([
        { limit: 2, offset: 0 },
        { limit: 2, offset: 2 },
        { limit: 2, offset: 4 }, // [5] — short page ends the loop
      ]);
    } finally {
      restore();
    }
  });

  it("on an exact page multiple, makes one trailing empty request to detect the end", async () => {
    const restore = setFindPageSizeForTest(2);
    try {
      const { windows, page } = pager([1, 2, 3, 4]);
      expect(await findAll(page)).toEqual([1, 2, 3, 4]);
      // A full last page is indistinguishable from "more remain" without
      // the trailing empty read — the off-by-one a naive loop gets wrong.
      expect(windows).toEqual([
        { limit: 2, offset: 0 },
        { limit: 2, offset: 2 },
        { limit: 2, offset: 4 },
      ]);
    } finally {
      restore();
    }
  });
});

// — Repo scans crossing a real page boundary (DO + TypeGraph) ——————————
// Page size shrunk to 2 so a handful of rows spans multiple `find()` pages;
// the seam is shared across the test isolate, so the in-DO scans page too.
describe("retention reap with protection sets spanning pages", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = setFindPageSizeForTest(2);
  });
  afterEach(() => restore());

  it("never reaps a live head's blob when the head scan spans pages", async () => {
    const store = freshStore("pg-reap");
    const slugs = ["a", "b", "c", "d", "e"]; // 5 heads > page size 2
    for (const s of slugs) {
      await store.saveDocument({
        slug: docSlug(s),
        markdown: `body-${s}`,
        clientVersion: 0,
        changedBy: "u",
      });
    }
    // blobDays only, future clock: every blob is "old" but referenced by a
    // live head, so a complete heads scan must delete nothing. A truncated
    // scan would drop the heads past page 1 and delete their blobs.
    const r = await store.reapExpired({ blobDays: 1 }, Date.now() + 5 * DAY);
    expect(r.blobsDeleted).toBe(0);
    for (const s of slugs) {
      expect((await store.getDocument(docSlug(s)))?.markdown).toBe(`body-${s}`);
    }
    expect(await store.verifyHistory()).toEqual({ ok: true });
  });

  it("keeps pinned non-head versions when the pinning collections span pages", async () => {
    const store = freshStore("pg-reap");
    const names = ["c1", "c2", "c3"]; // 3 CollectionVersions > page size 2
    for (let i = 0; i < names.length; i += 1) {
      const d = docSlug(`d${String(i)}`);
      const c = colSlug(names[i] ?? "");
      await store.saveDocument({
        slug: d,
        markdown: "v1",
        clientVersion: 0,
        changedBy: "u",
      });
      await store.saveDocument({
        slug: d,
        markdown: "v2",
        clientVersion: 1,
        changedBy: "u",
      });
      await store.createCollection({
        slug: c,
        name: names[i] ?? "",
        changedBy: "u",
      });
      await store.attachDocument(c, d, 1, "u"); // snapshot pins head v2
      await store.saveDocument({
        slug: d,
        markdown: "v3",
        clientVersion: 2,
        changedBy: "u",
      }); // head is now v3 — v2 is a pinned, non-head version
    }
    // v1 reaped, v2 pinned (survives), v3 head (survives) → one delete/doc.
    // A truncated pinned set would drop the page-2 collection and wrongly
    // reap its doc's v2.
    const r = await store.reapExpired(
      { documentVersionDays: 1 },
      Date.now() + 5 * DAY,
    );
    expect(r.versionsDeleted).toBe(names.length);
    for (let i = 0; i < names.length; i += 1) {
      expect(await store.versionCount(docSlug(`d${String(i)}`))).toBe(2);
    }
    expect(await store.verifyHistory()).toEqual({ ok: true });
  });
});

describe("folder cascade delete spanning pages", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = setFindPageSizeForTest(2);
  });
  afterEach(() => restore());

  it("deletes every descendant when the subtree spans pages (no orphans)", async () => {
    const store = freshStore("pg-folder");
    const root = await store.createFolder("root", null);
    expect(root.ok).toBe(true);
    if (!root.ok) return;
    for (let i = 0; i < 5; i += 1) {
      const child = await store.createFolder(
        `child-${String(i)}`,
        asFolderSlug(root.slug),
      );
      expect(child.ok).toBe(true);
    }
    expect((await store.listFolders()).length).toBe(6); // root + 5 > page size 2

    const del = await store.deleteFolder(asFolderSlug(root.slug), "u");
    expect(del.ok).toBe(true);
    // A truncated subtree scan would leave the folders past page 1 orphaned.
    expect(await store.listFolders()).toEqual([]);
  });
});
