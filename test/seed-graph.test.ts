import { describe, expect, it } from "vitest";

import { colSlug, docSlug, freshStore } from "./_helpers";

const ws = () => freshStore("seed");

describe("seedExample (atomic, guarded)", () => {
  it("seeds the shared-document example on an empty project", async () => {
    const w = ws();
    expect(await w.seedExample("u")).toEqual({ seeded: true });

    const docs = await w.listDocuments();
    const cols = await w.listCollections();
    const att = await w.listAttachments();

    expect(docs.map((d) => d.slug).sort()).toEqual([
      "brand-voice",
      "product",
      "refund-policy",
    ]);
    expect(cols.map((c) => c.slug).sort()).toEqual([
      "sales-agent",
      "support-agent",
    ]);
    // The whole point: ONE document, in BOTH collections.
    expect(
      att
        .filter((a) => a.documentSlug === "refund-policy")
        .map((a) => a.collectionSlug)
        .sort(),
    ).toEqual(["sales-agent", "support-agent"]);
    // product is present in Sales only (not stranded).
    expect(
      att
        .filter((a) => a.documentSlug === "product")
        .map((a) => a.collectionSlug),
    ).toEqual(["sales-agent"]);
    // brand-voice is present in Sales only (not stranded).
    expect(
      att
        .filter((a) => a.documentSlug === "brand-voice")
        .map((a) => a.collectionSlug),
    ).toEqual(["sales-agent"]);
  });

  it("is a no-op on a project that already has data (double-click safe)", async () => {
    const w = ws();
    expect(await w.seedExample("u")).toEqual({ seeded: true });
    // Second invocation — guard fires, nothing duplicates.
    expect(await w.seedExample("u")).toEqual({
      seeded: false,
      reason: "not_empty",
    });
    expect((await w.listDocuments()).length).toBe(3);
    expect((await w.listCollections()).length).toBe(2);
    expect((await w.listAttachments()).length).toBe(4);
  });

  it("refuses to seed when any document already exists", async () => {
    const w = ws();
    await w.saveDocument({
      slug: docSlug("mine"),
      markdown: "# mine",
      clientVersion: 0,
      changedBy: "u",
    });
    expect(await w.seedExample("u")).toEqual({
      seeded: false,
      reason: "not_empty",
    });
    expect((await w.listCollections()).length).toBe(0);
  });
});

describe("listAttachments", () => {
  it("is empty on a fresh project", async () => {
    expect(await ws().listAttachments()).toEqual([]);
  });

  it("reports position-ordered collection → document edges", async () => {
    const w = ws();
    await w.saveDocument({
      slug: docSlug("a"),
      markdown: "# a",
      clientVersion: 0,
      changedBy: "u",
    });
    await w.createCollection({ slug: colSlug("c"), name: "C", changedBy: "u" });
    await w.attachDocument(colSlug("c"), docSlug("a"), 1, "u");
    expect(await w.listAttachments()).toEqual([
      { collectionSlug: "c", documentSlug: "a", position: 1 },
    ]);
  });
});
