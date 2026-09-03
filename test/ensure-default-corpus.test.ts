import { describe, expect, it } from "vitest";

import { DEFAULT_CORPUS_SLUG } from "@/store/domain/default-corpus";

import { docSlug, freshStore } from "./_helpers";

const ws = () => freshStore("default-corpus");

describe("ensureDefaultCorpus", () => {
  it("creates the default corpus on an empty project", async () => {
    const w = ws();
    const first = await w.ensureDefaultCorpus("u");
    expect(first).toEqual({ slug: DEFAULT_CORPUS_SLUG, created: true });

    const cols = await w.listCorpora();
    expect(cols.map((c) => c.slug)).toEqual([DEFAULT_CORPUS_SLUG]);
  });

  it("is idempotent on a second call", async () => {
    const w = ws();
    expect(await w.ensureDefaultCorpus("u")).toEqual({
      slug: DEFAULT_CORPUS_SLUG,
      created: true,
    });
    expect(await w.ensureDefaultCorpus("u")).toEqual({
      slug: DEFAULT_CORPUS_SLUG,
      created: false,
    });
    expect((await w.listCorpora()).length).toBe(1);
  });
});

describe("seedExample with default corpus", () => {
  it("still seeds when only an empty default corpus exists", async () => {
    const w = ws();
    await w.ensureDefaultCorpus("u");
    expect(await w.seedExample("u")).toEqual({ seeded: true });
    expect((await w.listCorpora()).length).toBeGreaterThanOrEqual(2);
  });

  it("refuses to seed once the default corpus has a document", async () => {
    const w = ws();
    await w.ensureDefaultCorpus("u");
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
  });
});
