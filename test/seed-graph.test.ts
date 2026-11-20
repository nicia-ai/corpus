import { describe, expect, it } from "vitest";

import { DEFAULT_CORPUS_SLUG } from "../src/store/domain/default-corpus";

import { colSlug, docSlug, freshStore } from "./_helpers";

const ws = () => freshStore("seed");

const COMPANY = "company";
const SUPPORT_DESK = "support-desk";
const EXAMPLE_DOCUMENT_COUNT = 4;
const EXAMPLE_CORPUS_COUNT = 2;

describe("seedExample (atomic, guarded)", () => {
  it("seeds two corpora and four documents, each document in exactly one corpus", async () => {
    const w = ws();
    expect(await w.seedExample("u")).toEqual({ seeded: true });

    const docs = await w.listDocuments();
    const cols = await w.listCorpora();
    const members = await w.listResolvedMembers();

    expect(docs.map((d) => d.slug).sort()).toEqual([
      "brand-voice",
      "product",
      "refund-policy",
      "support-playbook",
    ]);
    expect(cols.map((c) => c.slug).sort()).toEqual([COMPANY, SUPPORT_DESK]);

    const corporaOf = (documentSlug: string): readonly string[] =>
      members
        .filter((m) => m.documentSlug === documentSlug)
        .map((m) => m.corpusSlug)
        .sort();
    expect(corporaOf("refund-policy")).toEqual([COMPANY]);
    expect(corporaOf("product")).toEqual([COMPANY]);
    expect(corporaOf("brand-voice")).toEqual([COMPANY]);
    expect(corporaOf("support-playbook")).toEqual([SUPPORT_DESK]);
  });

  it("is a no-op on a project that already has data (double-click safe)", async () => {
    const w = ws();
    expect(await w.seedExample("u")).toEqual({ seeded: true });
    // Second invocation — guard fires, nothing duplicates.
    expect(await w.seedExample("u")).toEqual({
      seeded: false,
      reason: "not_empty",
    });
    expect((await w.listDocuments()).length).toBe(EXAMPLE_DOCUMENT_COUNT);
    expect((await w.listCorpora()).length).toBe(EXAMPLE_CORPUS_COUNT);
    // One membership per document: no page sits in two corpora.
    expect((await w.listResolvedMembers()).length).toBe(EXAMPLE_DOCUMENT_COUNT);
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
    expect((await w.listCorpora()).map((c) => c.slug)).toEqual([
      DEFAULT_CORPUS_SLUG,
    ]);
  });
});

describe("listResolvedMembers", () => {
  it("is empty on a fresh project", async () => {
    expect(await ws().listResolvedMembers()).toEqual([]);
  });

  it("reports each document's corpus membership", async () => {
    const w = ws();
    await w.createCorpus({ slug: colSlug("c"), name: "C", changedBy: "u" });
    await w.saveDocument({
      slug: docSlug("a"),
      markdown: "# a",
      location: { corpusSlug: colSlug("c"), folderSlug: null },
      clientVersion: 0,
      changedBy: "u",
    });
    expect(await w.listResolvedMembers()).toEqual([
      { corpusSlug: "c", documentSlug: "a" },
    ]);
  });
});
