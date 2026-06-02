import { describe, expect, it } from "vitest";

import { colSlug, docSlug, freshStore } from "./_helpers";

const ws = () => freshStore("arch");

async function seedDocInCollection() {
  const w = ws();
  await w.saveDocument({
    slug: docSlug("alpha"),
    markdown: "# alpha\n\nbody",
    clientVersion: 0,
    changedBy: "u",
  });
  await w.saveDocument({
    slug: docSlug("bravo"),
    markdown: "# bravo\n\nbody",
    clientVersion: 0,
    changedBy: "u",
  });
  await w.createCollection({ slug: colSlug("c"), name: "C", changedBy: "u" });
  await w.attachDocument(colSlug("c"), docSlug("alpha"), 1, "u");
  await w.attachDocument(colSlug("c"), docSlug("bravo"), 2, "u");
  return w;
}

describe("document soft-delete (archive)", () => {
  it("detaches from collections, hides from list/get/read, keeps history", async () => {
    const w = await seedDocInCollection();

    expect(await w.archiveDocument(docSlug("alpha"), "dana")).toEqual({
      ok: true,
    });

    // Hidden from the working/MCP surfaces.
    expect((await w.listDocuments()).map((d) => d.slug)).toEqual(["bravo"]);
    expect(await w.getDocument(docSlug("alpha"))).toBeUndefined();

    // Detached: the collection no longer serves it.
    const r = await w.readCollection(colSlug("c"));
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
    const w = await seedDocInCollection();
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
    const w = await seedDocInCollection();
    await w.archiveDocument(docSlug("alpha"), "u");

    expect(
      await w.archiveDocuments(
        [docSlug("alpha"), docSlug("bravo"), docSlug("ghost")],
        "u",
      ),
    ).toEqual({ archived: 1 });

    expect(await w.listDocuments()).toEqual([]);
    const r = await w.readCollection(colSlug("c"));
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.documents).toEqual([]);
    expect(await w.verifyHistory()).toEqual({ ok: true });
  });
});
