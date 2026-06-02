import { describe, expect, it } from "vitest";

import { colSlug, docSlug, freshStore } from "./_helpers";

// End-to-end: the real save path (content-addressed blob + DocumentVersion
// chain) plus a CollectionVersion snapshot must verify intact, and a
// node-unique collision must surface as a 409 — never a thrown 500.
const project = () => freshStore("verify");

describe("verifyHistory (DO end-to-end)", () => {
  it("an intact project verifies ok", async () => {
    const store = project();
    await store.saveDocument({
      slug: docSlug("alpha"),
      markdown: "# Alpha\nv1",
      clientVersion: 0,
      changedBy: "u",
    });
    await store.saveDocument({
      slug: docSlug("alpha"),
      markdown: "# Alpha\nv2 expanded",
      clientVersion: 1,
      changedBy: "u",
    });
    await store.createCollection({
      slug: colSlug("c"),
      name: "C",
      changedBy: "u",
    });
    await store.attachDocument(colSlug("c"), docSlug("alpha"), 1, "u");

    expect(await store.verifyHistory()).toEqual({ ok: true });
    expect(await store.verifyHistory(docSlug("alpha"))).toEqual({ ok: true });
  });

  it("the version chain is the sole concurrency gate (409, not 500)", async () => {
    const store = project();
    await store.saveDocument({
      slug: docSlug("p"),
      markdown: "base",
      clientVersion: 0,
      changedBy: "u",
    });
    const [a, b] = await Promise.all([
      store.saveDocument({
        slug: docSlug("p"),
        markdown: "A",
        clientVersion: 1,
        changedBy: "a",
      }),
      store.saveDocument({
        slug: docSlug("p"),
        markdown: "B",
        clientVersion: 1,
        changedBy: "b",
      }),
    ]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    const loser = [a, b].find((r) => !r.ok);
    expect(loser).toMatchObject({ conflict: true, currentVersion: 2 });
    // Exactly base + one winner survived, and it still verifies.
    expect(await store.versionCount(docSlug("p"))).toBe(2);
    expect(await store.verifyHistory()).toEqual({ ok: true });
  });

  it("getDocument resolves content from the blob store (dedup head)", async () => {
    const store = project();
    await store.saveDocument({
      slug: docSlug("d"),
      markdown: "# canonical bytes",
      clientVersion: 0,
      changedBy: "u",
    });
    const head = await store.getDocument(docSlug("d"));
    expect(head?.markdown).toBe("# canonical bytes");
    expect(head?.docVersion).toBe(1);
  });
});
