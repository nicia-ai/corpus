import { describe, expect, it } from "vitest";

import { colSlug, docSlug, freshStore } from "./_helpers";

type Store = ReturnType<typeof freshStore>;

// `createDocumentInCollection` is the collection-scoped REST create path
// (api-key PUT to a slug the transport's member snapshot didn't list). The
// decision is re-made inside the write transaction, so a stale snapshot —
// or a racing create that won between snapshot and write — resolves to the
// right HTTP outcome rather than a misleading 403.

async function withCollection(
  prefix: string,
): Promise<{ store: Store; collectionSlug: ReturnType<typeof colSlug> }> {
  const store = freshStore(prefix);
  const collectionSlug = colSlug("team-docs");
  await store.createCollection({
    slug: collectionSlug,
    name: "Team Docs",
    changedBy: "owner",
  });
  return { store, collectionSlug };
}

describe("createDocumentInCollection (scoped create)", () => {
  it("creates a new document and attaches it to the collection", async () => {
    const { store, collectionSlug } = await withCollection("cic-new");
    const slug = docSlug("brand-new");
    expect(
      await store.createDocumentInCollection(
        { slug, markdown: "# New\n\nbody", clientVersion: 0, changedBy: "a" },
        collectionSlug,
        0,
      ),
    ).toMatchObject({ ok: true, docVersion: 1 });
    expect(await store.collectionMembers(collectionSlug)).toContain(slug);
    expect((await store.getDocument(slug))?.markdown).toBe("# New\n\nbody");
  });

  // An agent push must not grow the always-include payload: the curator
  // opts a member into "core" delivery, never the create path itself.
  it("attaches a created document with reference delivery", async () => {
    const { store, collectionSlug } = await withCollection("cic-delivery");
    const slug = docSlug("pushed-by-agent");
    expect(
      await store.createDocumentInCollection(
        {
          slug,
          markdown: "# Pushed\n\nbody",
          clientVersion: 0,
          changedBy: "a",
        },
        collectionSlug,
        0,
      ),
    ).toMatchObject({ ok: true, docVersion: 1 });
    const outline = await store.collectionOutline(collectionSlug);
    expect(outline.found).toBe(true);
    if (!outline.found) return;
    expect(outline.documents.map((d) => [d.slug, d.delivery])).toEqual([
      [slug, "reference"],
    ]);
  });

  // The bug: two clients create the same new slug into the same collection.
  // The first wins (creates + attaches v1). The second is AUTHORIZED for
  // that doc (it is now in the bound collection), so it must get a
  // retryable 409 conflict — NOT a 403, which would say "no authority here"
  // and strand the client.
  it("a racing same-collection create returns a retryable conflict, not 403", async () => {
    const { store, collectionSlug } = await withCollection("cic-race");
    const slug = docSlug("contested");
    const create = (): Promise<unknown> =>
      store.createDocumentInCollection(
        { slug, markdown: "# v1\n\nfirst", clientVersion: 0, changedBy: "a" },
        collectionSlug,
        0,
      );
    expect(await create()).toMatchObject({ ok: true, docVersion: 1 }); // winner
    expect(await create()).toMatchObject({
      ok: false,
      conflict: true,
      currentVersion: 1,
    });
  });

  it("refuses (forbidden) a slug that exists OUTSIDE the bound collection", async () => {
    const { store, collectionSlug } = await withCollection("cic-out");
    const slug = docSlug("outsider");
    // Loose document — created in the project but never attached.
    await store.saveDocument({
      slug,
      markdown: "secret",
      clientVersion: 0,
      changedBy: "owner",
    });
    expect(
      await store.createDocumentInCollection(
        { slug, markdown: "hijack", clientVersion: 0, changedBy: "intruder" },
        collectionSlug,
        0,
      ),
    ).toMatchObject({ ok: false, forbidden: true });
  });

  // "Created" must mean "created AND attached". If the bound collection is
  // gone when the attach runs, the whole unit rolls back — no document is
  // left created-but-unattached (which would be outside its own scope).
  it("rolls back with no orphan when the bound collection is gone", async () => {
    const store = freshStore("cic-ghost");
    const slug = docSlug("orphan-me");
    expect(
      await store.createDocumentInCollection(
        { slug, markdown: "# x\n\ny", clientVersion: 0, changedBy: "a" },
        colSlug("never-created"),
        0,
      ),
    ).toMatchObject({ ok: false, forbidden: true });
    expect(await store.getDocument(slug)).toBeUndefined();
  });
});
