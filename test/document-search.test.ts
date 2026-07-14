import { describe, expect, it } from "vitest";

import { asFolderSlug } from "@/ids";

import { docSlug, freshStore } from "./_helpers";

// Full-text search over live heads: title hits rank ahead of body-only
// hits, matching is case-insensitive, archived documents never surface,
// short queries return nothing, and results are capped.

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

describe("searchDocuments", () => {
  it("matches title and body, ranking title hits first", async () => {
    const store = freshProject();
    await seed(
      store,
      "pricing-notes",
      "# Assorted\nnothing relevant here",
      "Pricing Model",
    );
    await seed(
      store,
      "journey",
      "# Journey\nThe pricing conversation happens at stage three.",
      "Customer Journey",
    );
    await seed(store, "unrelated", "# Other\nno match at all", "Other");

    const hits = await store.searchDocuments("pricing");
    expect(hits.map((h) => h.slug)).toEqual(["pricing-notes", "journey"]);
    expect(hits[0]?.field).toBe("title");
    expect(hits[1]?.field).toBe("body");
    const body = hits[1];
    if (body === undefined) throw new Error("expected a body hit");
    expect(body.matchStart).toBeDefined();
    expect(
      body.snippet.slice(body.matchStart, body.matchEnd).toLowerCase(),
    ).toBe("pricing");
  });

  it("is case-insensitive in both directions", async () => {
    const store = freshProject();
    await seed(store, "style", "# Style\nThe Primary Palette is slate.");
    expect(await store.searchDocuments("primary palette")).toHaveLength(1);
    expect(await store.searchDocuments("PRIMARY PALETTE")).toHaveLength(1);
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

  it("surfaces a body match after a case-expanding char without a wrong highlight", async () => {
    // U+0130 (İ) lowercases to two code units, so a match index computed on
    // the lowercased body no longer aligns with the original-cased body the
    // snippet slices. The hit must still surface, but with no highlight
    // offsets rather than an off-by-one (wrong) span.
    const store = freshProject();
    await seed(store, "istanbul", "İ then the pricing section.", "Istanbul");
    const hits = await store.searchDocuments("pricing");
    expect(hits.map((h) => h.slug)).toEqual(["istanbul"]);
    expect(hits[0]?.field).toBe("body");
    expect(hits[0]?.matchStart).toBeUndefined();
    expect(hits[0]?.matchEnd).toBeUndefined();
  });
});
