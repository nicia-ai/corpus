import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { asFolderSlug } from "@/ids";
import { toSafeFulltextQuery } from "@/store/domain/search";
import type { CorpusStore } from "@/store/handle";

import { docSlug, freshStore } from "./_helpers";

// Full-text search over live document heads via TypeGraph's FTS5 index:
// tokenized so multi-word queries match non-adjacent terms, bm25-ranked (not
// path-ordered), case-insensitive, archived docs excluded, query syntax
// sanitized against injection, and pre-existing docs backfilled on first use.

const freshProject = () => freshStore("search");

async function seed(
  store: ReturnType<typeof freshProject>,
  slug: string,
  markdown: string,
  title?: string,
): Promise<void> {
  const r = await store.saveDocument({
    slug: docSlug(slug),
    markdown,
    ...(title === undefined ? {} : { title }),
    clientVersion: 0,
    changedBy: "alice",
  });
  expect(r.ok).toBe(true);
}

describe("toSafeFulltextQuery", () => {
  it("keeps word tokens and collapses whitespace", () => {
    expect(toSafeFulltextQuery("  Primary   Palette ")).toBe("Primary Palette");
  });

  it("strips FTS5 operator characters so a query cannot inject", () => {
    expect(toSafeFulltextQuery('a" OR "b')).toBe("a OR b");
    expect(toSafeFulltextQuery("NEAR(foo, bar)")).toBe("NEAR foo bar");
    expect(toSafeFulltextQuery("widget*")).toBe("widget");
    expect(toSafeFulltextQuery('"""')).toBe("");
  });

  it("keeps unicode letters and digits", () => {
    expect(toSafeFulltextQuery("café 2024")).toBe("café 2024");
  });
});

describe("searchDocuments", () => {
  it("matches multi-word queries whose terms are not adjacent", async () => {
    const store = freshProject();
    await seed(
      store,
      "journey",
      "# Journey\nThe primary concern is the palette.",
    );
    // A substring scan would miss this (the terms aren't contiguous).
    const hits = await store.searchDocuments("primary palette");
    expect(hits.map((h) => h.slug)).toEqual(["journey"]);
  });

  it("ranks by relevance, not path order", async () => {
    const store = freshProject();
    // Sorts first by path, but barely mentions the term.
    await seed(
      store,
      "aaa-barely",
      "widget then padding padding padding padding padding padding padding",
      "Alpha",
    );
    // Sorts last by path, but is dense with the term.
    await seed(
      store,
      "zzz-relevant",
      "widget widget widget widget widget widget",
      "Beta",
    );
    const hits = await store.searchDocuments("widget");
    expect(hits.map((h) => h.slug)).toEqual(["zzz-relevant", "aaa-barely"]);
  });

  it("is case-insensitive in both directions", async () => {
    const store = freshProject();
    await seed(store, "style", "# Style\nThe Primary Palette is slate.");
    expect(await store.searchDocuments("primary palette")).toHaveLength(1);
    expect(await store.searchDocuments("PRIMARY PALETTE")).toHaveLength(1);
  });

  it("returns a highlighted snippet around the match", async () => {
    const store = freshProject();
    await seed(store, "doc", "# Doc\nthe quick brown fox jumps");
    const [hit] = await store.searchDocuments("brown");
    expect(hit?.snippet).toContain("<mark>brown</mark>");
  });

  it("returns the document's derived path", async () => {
    const store = freshProject();
    const folder = await store.createFolder("wiki", null);
    if (!folder.ok) throw new Error("folder create failed");
    await seed(store, "concept", "# Concept\nself-serve onboarding");
    await store.placeDocumentInFolder(
      docSlug("concept"),
      asFolderSlug(folder.slug),
      "alice",
    );
    const hits = await store.searchDocuments("self-serve");
    expect(hits[0]?.path).toBe("wiki/concept.md");
  });

  it("excludes archived documents", async () => {
    const store = freshProject();
    await seed(store, "gone", "# Gone\nsearchable phrase");
    await store.archiveDocument(docSlug("gone"), "alice");
    expect(await store.searchDocuments("searchable phrase")).toHaveLength(0);
  });

  it("does not throw or inject on FTS5 query syntax", async () => {
    const store = freshProject();
    await seed(store, "doc", "# Doc\nalpha beta gamma");
    for (const q of [
      'a" OR "b',
      "NEAR(alpha",
      "beta*",
      '"unbalanced',
      "((()",
    ]) {
      expect(Array.isArray(await store.searchDocuments(q))).toBe(true);
    }
    // A wildcard-looking query still finds the plain token it sanitizes to.
    expect(await store.searchDocuments("beta*")).toHaveLength(1);
  });

  it("rejects queries shorter than two characters", async () => {
    const store = freshProject();
    await seed(store, "doc", "# Doc\nx marks the spot");
    expect(await store.searchDocuments("x")).toHaveLength(0);
    expect(await store.searchDocuments("  x  ")).toHaveLength(0);
  });

  it("caps results at twenty", async () => {
    const store = freshProject();
    for (let i = 0; i < 25; i += 1) {
      await seed(store, `match-${String(i)}`, "# M\ncommon needle text");
    }
    expect(await store.searchDocuments("common needle")).toHaveLength(20);
  });

  it("backfills pre-existing docs across batches, then indexes them", async () => {
    const store = freshStore("search-backfill");
    // Simulate pre-migration rows: Document nodes created straight through
    // the graph store with NO searchText (as if written before the
    // searchable() field existed). 101 > the 100-doc batch size, so a
    // correct backfill must span more than one transaction.
    await runInDurableObject(store, async (instance) => {
      const inst = instance as unknown as {
        ensureStore(): Promise<CorpusStore>;
      };
      const s = await inst.ensureStore();
      await s.transaction(async (tx) => {
        for (let i = 0; i < 101; i += 1) {
          await tx.nodes.Document.create({
            slug: `legacy-${String(i)}`,
            title: `Legacydoc ${String(i)}`,
            filename: `legacy-${String(i)}.md`,
            contentHash: `hash-${String(i)}`,
            docVersion: 1,
            updatedAt: "2020-01-01T00:00:00.000Z",
          });
        }
      });
    });
    // The paginated backfill must process every row (101 = two batches).
    expect(await store.reindexSearchText()).toBe(101);
    // And they are now searchable (title backfilled; capped at 20).
    expect(await store.searchDocuments("legacydoc")).toHaveLength(20);
  });

  it("keeps an archived document out of search after a rename", async () => {
    const store = freshProject();
    await seed(store, "gone", "# Gone\nsearchable phrase");
    await store.archiveDocument(docSlug("gone"), "alice");
    const r = await store.renameDocument({
      slug: docSlug("gone"),
      title: "Renamed Gone",
      changedBy: "alice",
    });
    expect(r.ok).toBe(true);
    expect(await store.searchDocuments("searchable phrase")).toHaveLength(0);
    expect(await store.searchDocuments("renamed gone")).toHaveLength(0);
  });

  it("keeps an archived document out of search after a save", async () => {
    const store = freshProject();
    await seed(store, "gone", "# Gone\noriginal phrase");
    await store.archiveDocument(docSlug("gone"), "alice");
    const r = await store.saveDocument({
      slug: docSlug("gone"),
      markdown: "# Gone\nbrandnew phrase",
      clientVersion: 1,
      changedBy: "alice",
    });
    expect(r.ok).toBe(true);
    expect(await store.searchDocuments("brandnew phrase")).toHaveLength(0);
  });
});
