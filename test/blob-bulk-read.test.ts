import { describe, expect, it } from "vitest";

import { asDocumentSlug } from "../src/ids";

import { colSlug, freshStore } from "./_helpers";

// A Durable Object's SQLite allows 100 bound parameters per statement. Every
// read that resolves a set of blob hashes must stay under it however many
// documents the project holds.
const DOCUMENT_COUNT = 260;
const ATTACHED_COUNT = 120;
const SEEDING_TIMEOUT_MS = 120_000;
const BUNDLE_SOURCE = { organization: "acme", project: "default" };

describe("bulk blob reads on a project with more than 100 documents", () => {
  it(
    "lists, exports and computes stats",
    async () => {
      const store = freshStore("blob-bulk");
      for (let i = 0; i < DOCUMENT_COUNT; i += 1) {
        await store.importDocumentAtPath({
          path: `notes/note-${String(i).padStart(3, "0")}.md`,
          markdown: `# Note ${String(i)}\n\nbody ${String(i)}\n`,
          changedBy: "u",
        });
      }

      const stats = await store.statsSnapshot();
      expect(stats.documents.total).toBe(DOCUMENT_COUNT);

      const listed = await store.listDocuments();
      expect(listed).toHaveLength(DOCUMENT_COUNT);

      const corpus = colSlug("bulk");
      await store.createCorpus({ slug: corpus, name: "bulk", changedBy: "u" });
      for (const [i, row] of listed.slice(0, ATTACHED_COUNT).entries()) {
        await store.attachDocument(
          corpus,
          asDocumentSlug(row.slug),
          i + 1,
          "u",
        );
      }

      expect(await store.corpusMembers(corpus)).toHaveLength(ATTACHED_COUNT);
      expect((await store.readCorpus(corpus)).found).toBe(true);
      expect((await store.corpusStructure(corpus)).found).toBe(true);
      expect(await store.listResolvedMembers()).toHaveLength(ATTACHED_COUNT);
      expect(await store.listDocumentRefs()).toHaveLength(DOCUMENT_COUNT);
      expect((await store.searchDocuments("body")).length).toBeGreaterThan(0);
      expect((await store.verifyHistory()).ok).toBe(true);
      await store.usageSnapshot();
      expect((await store.statsSnapshot()).corpora.totalMembers).toBe(
        ATTACHED_COUNT,
      );

      const bundle = await store.exportBundle(BUNDLE_SOURCE);
      expect(bundle.manifest.documents).toHaveLength(DOCUMENT_COUNT);
    },
    SEEDING_TIMEOUT_MS,
  );
});
