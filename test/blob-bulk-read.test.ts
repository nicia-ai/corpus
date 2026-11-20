import { describe, expect, it } from "vitest";

import { DEFAULT_CORPUS_SLUG } from "../src/store/domain/default-corpus";

import { colSlug, freshStore } from "./_helpers";

// A Durable Object's SQLite allows 100 bound parameters per statement. Every
// read that resolves a set of blob hashes must stay under it however many
// documents the project holds.
const DOCUMENT_COUNT = 260;
const IN_CORPUS_COUNT = 120;
const SEEDING_TIMEOUT_MS = 120_000;
const BUNDLE_SOURCE = { organization: "acme", project: "default" };

describe("bulk blob reads on a project with more than 100 documents", () => {
  it(
    "lists, exports and computes stats",
    async () => {
      const store = freshStore("blob-bulk");
      const corpus = colSlug("bulk");
      await store.createCorpus({ slug: corpus, name: "bulk", changedBy: "u" });
      await store.ensureDefaultCorpus("u");
      // 120 pages in the corpus, the other 140 in Drafts.
      for (let i = 0; i < DOCUMENT_COUNT; i += 1) {
        const r = await store.importDocumentAtPath({
          corpusSlug: i < IN_CORPUS_COUNT ? corpus : DEFAULT_CORPUS_SLUG,
          path: `notes/note-${String(i).padStart(3, "0")}.md`,
          markdown: `# Note ${String(i)}\n\nbody ${String(i)}\n`,
          changedBy: "u",
        });
        expect(r.ok).toBe(true);
      }

      const stats = await store.statsSnapshot();
      expect(stats.documents.total).toBe(DOCUMENT_COUNT);

      const listed = await store.listDocuments();
      expect(listed).toHaveLength(DOCUMENT_COUNT);

      expect(await store.corpusMembers(corpus)).toHaveLength(IN_CORPUS_COUNT);
      const outline = await store.corpusOutline(corpus);
      expect(outline.found && outline.documents).toHaveLength(IN_CORPUS_COUNT);
      expect(await store.listResolvedMembers()).toHaveLength(DOCUMENT_COUNT);
      expect(await store.listDocumentRefs()).toHaveLength(DOCUMENT_COUNT);
      expect((await store.searchDocuments("body")).length).toBeGreaterThan(0);
      expect((await store.verifyHistory()).ok).toBe(true);
      await store.usageSnapshot();
      const after = await store.statsSnapshot();
      expect(after.corpora.totalMembers).toBe(DOCUMENT_COUNT);
      expect(after.corpora.defaultMembers).toBe(
        DOCUMENT_COUNT - IN_CORPUS_COUNT,
      );

      const bundle = await store.exportBundle(BUNDLE_SOURCE);
      expect(bundle.manifest.documents).toHaveLength(DOCUMENT_COUNT);
    },
    SEEDING_TIMEOUT_MS,
  );
});
