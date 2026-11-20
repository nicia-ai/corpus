import { describe, expect, it } from "vitest";

import { colSlug, docSlug, freshStore } from "./_helpers";

const ws = () => freshStore("arch");

const CORPUS_ROOT = { corpusSlug: colSlug("c"), folderSlug: null } as const;

async function seedDocInCorpus() {
  const w = ws();
  await w.createCorpus({ slug: colSlug("c"), name: "C", changedBy: "u" });
  await w.saveDocument({
    slug: docSlug("alpha"),
    markdown: "# alpha\n\nbody",
    location: CORPUS_ROOT,
    clientVersion: 0,
    changedBy: "u",
  });
  await w.saveDocument({
    slug: docSlug("bravo"),
    markdown: "# bravo\n\nbody",
    location: CORPUS_ROOT,
    clientVersion: 0,
    changedBy: "u",
  });
  return w;
}

describe("document soft-delete (archive)", () => {
  it("detaches from corpora, hides from list/get/read, keeps history", async () => {
    const w = await seedDocInCorpus();

    expect(await w.archiveDocument(docSlug("alpha"), "dana")).toEqual({
      ok: true,
    });

    // Hidden from the working/MCP surfaces.
    expect((await w.listDocuments()).map((d) => d.slug)).toEqual(["bravo"]);
    expect(await w.getDocument(docSlug("alpha"))).toBeUndefined();

    // Gone from the corpus outline too.
    const r = await w.corpusOutline(colSlug("c"));
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.documents.map((d) => d.slug)).toEqual(["bravo"]);

    // Audit: the newest event is the archive (logged after the detach).
    const [latest] = await w.recentChanges(1);
    expect(latest).toMatchObject({
      eventType: "document.archived",
      documentSlug: "alpha",
      changedBy: "dana",
    });

    // The version chain is untouched — history still verifies.
    expect(await w.verifyHistory()).toEqual({ ok: true });
  });

  it("is idempotent: re-archiving is a no-op", async () => {
    const w = await seedDocInCorpus();
    expect(await w.archiveDocument(docSlug("alpha"), "u")).toEqual({
      ok: true,
    });
    expect(await w.archiveDocument(docSlug("alpha"), "u")).toEqual({
      ok: false,
    });
    expect(await w.archiveDocument(docSlug("ghost"), "u")).toEqual({
      ok: false,
    });
  });

  it("bulk archive returns the count and skips missing/already-archived", async () => {
    const w = await seedDocInCorpus();
    await w.archiveDocument(docSlug("alpha"), "u");

    expect(
      await w.archiveDocuments(
        [docSlug("alpha"), docSlug("bravo"), docSlug("ghost")],
        "u",
      ),
    ).toEqual({ archived: 1 });

    expect(await w.listDocuments()).toEqual([]);
    const r = await w.corpusOutline(colSlug("c"));
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.documents).toEqual([]);
    expect(await w.verifyHistory()).toEqual({ ok: true });
  });
});
