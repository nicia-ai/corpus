import { describe, expect, it } from "vitest";

import { colSlug, docSlug, freshStore } from "./_helpers";

const ws = () => freshStore("seed");

describe("seedExample (atomic, guarded)", () => {
  it("seeds the shared-document example on an empty project", async () => {
    const w = ws();
    expect(await w.seedExample("u")).toEqual({ seeded: true });

    const docs = await w.listDocuments();
    const cols = await w.listCollections();
    const members = await w.listResolvedMembers();

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
      members
        .filter((m) => m.documentSlug === "refund-policy")
        .map((m) => m.collectionSlug)
        .sort(),
    ).toEqual(["sales-agent", "support-agent"]);
    // product is present in Sales only (not stranded).
    expect(
      members
        .filter((m) => m.documentSlug === "product")
        .map((m) => m.collectionSlug),
    ).toEqual(["sales-agent"]);
    // brand-voice is present in Sales only (not stranded).
    expect(
      members
        .filter((m) => m.documentSlug === "brand-voice")
        .map((m) => m.collectionSlug),
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
    // 4 resolved memberships: refund-policy ×2 + product + brand-voice.
    expect((await w.listResolvedMembers()).length).toBe(4);
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

describe("listResolvedMembers", () => {
  it("is empty on a fresh project", async () => {
    expect(await ws().listResolvedMembers()).toEqual([]);
  });

  it("reports each resolved collection → document membership", async () => {
    const w = ws();
    await w.saveDocument({
      slug: docSlug("a"),
      markdown: "# a",
      clientVersion: 0,
      changedBy: "u",
    });
    await w.createCollection({ slug: colSlug("c"), name: "C", changedBy: "u" });
    await w.attachDocument(colSlug("c"), docSlug("a"), 1, "u");
    expect(await w.listResolvedMembers()).toEqual([
      { collectionSlug: "c", documentSlug: "a" },
    ]);
  });
});
