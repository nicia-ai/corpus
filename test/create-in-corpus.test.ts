import { describe, expect, it } from "vitest";

import { colSlug, docSlug, freshStore } from "./_helpers";

type Store = ReturnType<typeof freshStore>;

// `createDocumentInCorpus` is the corpus-scoped REST create path
// (api-key PUT to a slug the transport's member snapshot didn't list). The
// decision is re-made inside the write transaction, so a stale snapshot —
// or a racing create that won between snapshot and write — resolves to the
// right HTTP outcome rather than a misleading 403.

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

describe("createDocumentInCorpus (scoped create)", () => {
  it("creates a new document and attaches it to the corpus", async () => {
    const { store, corpusSlug } = await withCorpus("cic-new");
    const slug = docSlug("brand-new");
    expect(
      await store.createDocumentInCorpus(
        { slug, markdown: "# New\n\nbody", clientVersion: 0, changedBy: "a" },
        corpusSlug,
        0,
      ),
    ).toMatchObject({ ok: true, docVersion: 1 });
    expect(await store.corpusMembers(corpusSlug)).toContain(slug);
    expect((await store.getDocument(slug))?.markdown).toBe("# New\n\nbody");
  });

  // An agent push must not grow the always-include payload: the curator
  // opts a member into "core" delivery, never the create path itself.
  it("attaches a created document with reference delivery", async () => {
    const { store, corpusSlug } = await withCorpus("cic-delivery");
    const slug = docSlug("pushed-by-agent");
    expect(
      await store.createDocumentInCorpus(
        {
          slug,
          markdown: "# Pushed\n\nbody",
          clientVersion: 0,
          changedBy: "a",
        },
        corpusSlug,
        0,
      ),
    ).toMatchObject({ ok: true, docVersion: 1 });
    const outline = await store.corpusOutline(corpusSlug);
    expect(outline.found).toBe(true);
    if (!outline.found) return;
    expect(outline.documents.map((d) => [d.slug, d.delivery])).toEqual([
      [slug, "reference"],
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
      store.createDocumentInCorpus(
        { slug, markdown: "# v1\n\nfirst", clientVersion: 0, changedBy: "a" },
        corpusSlug,
        0,
      );
    expect(await create()).toMatchObject({ ok: true, docVersion: 1 }); // winner
    expect(await create()).toMatchObject({
      ok: false,
      conflict: true,
      currentVersion: 1,
    });
  });

  it("refuses (forbidden) a slug that exists OUTSIDE the bound corpus", async () => {
    const { store, corpusSlug } = await withCorpus("cic-out");
    const slug = docSlug("outsider");
    // Loose document — created in the project but never attached.
    await store.saveDocument({
      slug,
      markdown: "secret",
      clientVersion: 0,
      changedBy: "owner",
    });
    expect(
      await store.createDocumentInCorpus(
        { slug, markdown: "hijack", clientVersion: 0, changedBy: "intruder" },
        corpusSlug,
        0,
      ),
    ).toMatchObject({ ok: false, forbidden: true });
  });

  // "Created" must mean "created AND attached". If the bound corpus is
  // gone when the attach runs, the whole unit rolls back — no document is
  // left created-but-unattached (which would be outside its own scope).
  it("rolls back with no orphan when the bound corpus is gone", async () => {
    const store = freshStore("cic-ghost");
    const slug = docSlug("orphan-me");
    expect(
      await store.createDocumentInCorpus(
        { slug, markdown: "# x\n\ny", clientVersion: 0, changedBy: "a" },
        colSlug("never-created"),
        0,
      ),
    ).toMatchObject({ ok: false, forbidden: true });
    expect(await store.getDocument(slug)).toBeUndefined();
  });
});
