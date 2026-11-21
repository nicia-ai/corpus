import { describe, expect, it } from "vitest";

import { docSlug, freshStore } from "./_helpers";

// A Durable Object's SQLite allows 100 bound parameters per statement. The
// review layer resolves messages and hunks for every thread / suggestion on a
// page with one `IN (...)`, so a page past 100 of either must still load.
const REVIEW_ITEM_COUNT = 130;
const SEEDING_TIMEOUT_MS = 120_000;
const AUTHOR = "alice";
const BASE = "alpha lead\n\nbeta middle here";

async function seededPage(prefix: string) {
  const store = freshStore(prefix);
  const slug = docSlug("busy-page");
  const saved = await store.saveDocument({
    slug,
    markdown: BASE,
    clientVersion: 0,
    changedBy: AUTHOR,
  });
  expect(saved).toMatchObject({ ok: true, docVersion: 1 });
  return { store, slug };
}

describe("review reads on a page with more than 100 threads or suggestions", () => {
  it(
    "lists every comment thread with its messages, oldest first",
    async () => {
      const { store, slug } = await seededPage("review-comments");
      for (let i = 0; i < REVIEW_ITEM_COUNT; i += 1) {
        const created = await store.createComment({
          slug,
          blockIndex: 1,
          start: 0,
          end: 11,
          body: `comment ${String(i)}`,
          clientVersion: 1,
          createdBy: AUTHOR,
        });
        expect(created.ok, `comment ${String(i)}`).toBe(true);
      }

      const threads = await store.listComments(slug);
      expect(threads).toHaveLength(REVIEW_ITEM_COUNT);
      const bodies = threads.flatMap((t) => t.comments.map((c) => c.body));
      expect(bodies).toEqual(
        Array.from(
          { length: REVIEW_ITEM_COUNT },
          (_, i) => `comment ${String(i)}`,
        ),
      );
    },
    SEEDING_TIMEOUT_MS,
  );

  it(
    "lists every suggestion with its hunks and messages",
    async () => {
      const { store, slug } = await seededPage("review-suggestions");
      for (let i = 0; i < REVIEW_ITEM_COUNT; i += 1) {
        const created = await store.createSuggestion({
          slug,
          proposedMarkdown: `${BASE}\n\nproposal ${String(i)}`,
          clientVersion: 1,
          createdBy: AUTHOR,
          channel: "web",
        });
        expect(created.ok, `suggestion ${String(i)}`).toBe(true);
        if (!created.ok) continue;
        await store.addSuggestionMessage({
          suggestionId: created.suggestionId,
          body: `note ${String(i)}`,
          createdBy: AUTHOR,
          channel: "web",
        });
      }

      const suggestions = await store.listSuggestions(slug);
      expect(suggestions).toHaveLength(REVIEW_ITEM_COUNT);
      for (const s of suggestions) {
        expect(s.hunks.length).toBeGreaterThan(0);
        expect(s.messages).toHaveLength(1);
      }
    },
    SEEDING_TIMEOUT_MS,
  );

  it(
    "lists every open create-proposal with its messages",
    async () => {
      const store = freshStore("review-creates");
      for (let i = 0; i < REVIEW_ITEM_COUNT; i += 1) {
        const created = await store.createDocProposal({
          slug: docSlug(`proposed-${String(i)}`),
          proposedMarkdown: `# Proposed ${String(i)}`,
          createdBy: AUTHOR,
        });
        expect(created.ok, `proposal ${String(i)}`).toBe(true);
        if (!created.ok) continue;
        await store.addSuggestionMessage({
          suggestionId: created.suggestionId,
          body: `note ${String(i)}`,
          createdBy: AUTHOR,
          channel: "web",
        });
      }

      const proposals = await store.listCreateProposals();
      expect(proposals).toHaveLength(REVIEW_ITEM_COUNT);
    },
    SEEDING_TIMEOUT_MS,
  );
});
