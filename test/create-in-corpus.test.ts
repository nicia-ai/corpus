import { describe, expect, it } from "vitest";

import { colSlug, docSlug, freshStore } from "./_helpers";

type Store = ReturnType<typeof freshStore>;

// `saveDocumentInCorpus` is the corpus-scoped REST create path (api-key PUT
// to a slug the transport's member snapshot didn't list). The decision is
// re-made inside the write transaction, so a stale snapshot — or a racing
// create that won between snapshot and write — resolves to the right HTTP
// outcome rather than a misleading 403.

const NEW_DOCUMENT_VERSION = 0;
const FIRST_DOCUMENT_VERSION = 1;

async function withCorpus(
  prefix: string,
): Promise<{ store: Store; corpusSlug: ReturnType<typeof colSlug> }> {
  const store = freshStore(prefix);
  const corpusSlug = colSlug("team-docs");
  await store.createCorpus({
    slug: corpusSlug,
    name: "Team Docs",
    changedBy: "owner",
  });
  return { store, corpusSlug };
}

describe("saveDocumentInCorpus (scoped create)", () => {
  it("creates a new document in the bound corpus", async () => {
    const { store, corpusSlug } = await withCorpus("cic-new");
    const slug = docSlug("brand-new");
    expect(
      await store.saveDocumentInCorpus(
        {
          slug,
          markdown: "# New\n\nbody",
          clientVersion: NEW_DOCUMENT_VERSION,
          changedBy: "a",
        },
        corpusSlug,
      ),
    ).toMatchObject({ ok: true, docVersion: FIRST_DOCUMENT_VERSION });
    expect(await store.corpusMembers(corpusSlug)).toContain(slug);
    expect((await store.getDocument(slug))?.markdown).toBe("# New\n\nbody");
  });

  // A new document lands at the corpus root under its default filename, so
  // the outline reports the corpus-relative path an agent will address it by.
  it("places a created document at its corpus-relative path", async () => {
    const { store, corpusSlug } = await withCorpus("cic-path");
    const slug = docSlug("pushed-by-agent");
    expect(
      await store.saveDocumentInCorpus(
        {
          slug,
          markdown: "# Pushed\n\nbody",
          clientVersion: NEW_DOCUMENT_VERSION,
          changedBy: "a",
        },
        corpusSlug,
      ),
    ).toMatchObject({ ok: true, docVersion: FIRST_DOCUMENT_VERSION });
    const outline = await store.corpusOutline(corpusSlug);
    expect(outline.found).toBe(true);
    if (!outline.found) return;
    expect(outline.documents.map((d) => [d.slug, d.path])).toEqual([
      [slug, `${slug}.md`],
    ]);
  });

  // The bug: two clients create the same new slug into the same corpus.
  // The first wins (creates + attaches v1). The second is AUTHORIZED for
  // that doc (it is now in the bound corpus), so it must get a
  // retryable 409 conflict — NOT a 403, which would say "no authority here"
  // and strand the client.
  it("a racing same-corpus create returns a retryable conflict, not 403", async () => {
    const { store, corpusSlug } = await withCorpus("cic-race");
    const slug = docSlug("contested");
    const create = (): Promise<unknown> =>
      store.saveDocumentInCorpus(
        {
          slug,
          markdown: "# v1\n\nfirst",
          clientVersion: NEW_DOCUMENT_VERSION,
          changedBy: "a",
        },
        corpusSlug,
      );
    expect(await create()).toMatchObject({
      ok: true,
      docVersion: FIRST_DOCUMENT_VERSION,
    }); // winner
    expect(await create()).toMatchObject({
      ok: false,
      conflict: true,
      currentVersion: FIRST_DOCUMENT_VERSION,
    });
  });

  it("refuses (forbidden) a slug that exists OUTSIDE the bound corpus", async () => {
    const { store, corpusSlug } = await withCorpus("cic-out");
    const slug = docSlug("outsider");
    // Lives in the default corpus (the drafts space), never the bound one.
    await store.saveDocument({
      slug,
      markdown: "secret",
      clientVersion: NEW_DOCUMENT_VERSION,
      changedBy: "owner",
    });
    expect(
      await store.saveDocumentInCorpus(
        {
          slug,
          markdown: "hijack",
          clientVersion: NEW_DOCUMENT_VERSION,
          changedBy: "intruder",
        },
        corpusSlug,
      ),
    ).toMatchObject({ ok: false, forbidden: true });
  });

  // "Created" must mean "created AND placed". If the bound corpus is gone
  // when the create runs, nothing is written — no document is left
  // created-but-outside-its-scope.
  it("rolls back with no orphan when the bound corpus is gone", async () => {
    const store = freshStore("cic-ghost");
    const slug = docSlug("orphan-me");
    expect(
      await store.saveDocumentInCorpus(
        {
          slug,
          markdown: "# x\n\ny",
          clientVersion: NEW_DOCUMENT_VERSION,
          changedBy: "a",
        },
        colSlug("never-created"),
      ),
    ).toMatchObject({ ok: false, forbidden: true });
    expect(await store.getDocument(slug)).toBeUndefined();
  });
});
