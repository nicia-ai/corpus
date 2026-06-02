import { describe, expect, it } from "vitest";

import { docSlug, freshStore } from "./_helpers";

// Each test gets a fresh project id → a clean ProjectStore instance.
const freshProject = () => freshStore("history");

describe("documentHistory — the version chain, newest first, bodies resolved", () => {
  it("returns every version newest-first with its own content + author", async () => {
    const store = freshProject();
    const slug = docSlug("brand-voice");

    await store.saveDocument({
      slug,
      markdown: "# Brand Voice\nv1",
      clientVersion: 0,
      changedBy: "alice",
    });
    await store.saveDocument({
      slug,
      markdown: "# Brand Voice\nv2",
      clientVersion: 1,
      changedBy: "bob",
    });
    await store.saveDocument({
      slug,
      markdown: "# Brand Voice\nv3",
      clientVersion: 2,
      changedBy: "carol",
    });

    const history = await store.documentHistory(slug);

    expect(history.map((h) => h.docVersion)).toEqual([3, 2, 1]);
    expect(history[0]).toMatchObject({
      docVersion: 3,
      changedBy: "carol",
      markdown: "# Brand Voice\nv3",
      retained: true,
    });
    expect(history[2]).toMatchObject({
      docVersion: 1,
      changedBy: "alice",
      markdown: "# Brand Voice\nv1",
      retained: true,
    });
    // Head content matches the newest history entry.
    expect((await store.getDocument(slug))?.markdown).toBe(
      history[0]?.markdown,
    );
  });

  it("a single-version document has one retained entry", async () => {
    const store = freshProject();
    const slug = docSlug("icp");
    await store.saveDocument({
      slug,
      markdown: "only version",
      clientVersion: 0,
      changedBy: "alice",
    });

    const history = await store.documentHistory(slug);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      docVersion: 1,
      markdown: "only version",
      retained: true,
    });
  });

  it("an unknown slug has no history", async () => {
    const store = freshProject();
    expect(await store.documentHistory(docSlug("nope"))).toEqual([]);
  });
});
