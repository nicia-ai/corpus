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

  it("loads lineage metadata plus only the selected version body for the page", async () => {
    const store = freshProject();
    const slug = docSlug("positioning");
    for (const [index, markdown] of ["v1", "v2", "v3"].entries()) {
      await store.saveDocument({
        slug,
        markdown,
        clientVersion: index,
        changedBy: "alice",
      });
    }

    const defaultPage = await store.documentHistoryPageSnapshot(slug);
    expect(defaultPage.history.map((entry) => entry.docVersion)).toEqual([
      3, 2, 1,
    ]);
    expect(defaultPage.history[0]).not.toHaveProperty("markdown");
    expect(defaultPage.active).toMatchObject({
      docVersion: 2,
      markdown: "v2",
      retained: true,
    });

    const selectedPage = await store.documentHistoryPageSnapshot(slug, 1);
    expect(selectedPage.active).toMatchObject({
      docVersion: 1,
      markdown: "v1",
    });
    await expect(
      store.documentHistoryPageSnapshot(slug, 99),
    ).resolves.toMatchObject({ active: undefined });

    await expect(store.documentHistoryVersion(slug, 3)).resolves.toMatchObject({
      docVersion: 3,
      markdown: "v3",
      retained: true,
    });
    await expect(
      store.documentHistoryVersion(slug, 99),
    ).resolves.toBeUndefined();
  });

  it("pages retention metadata beyond one safe SQLite parameter batch", async () => {
    const store = freshProject();
    const slug = docSlug("long-lived");
    for (let index = 0; index < 105; index += 1) {
      await store.saveDocument({
        slug,
        markdown: `version ${index.toString()}`,
        clientVersion: index,
        changedBy: "alice",
      });
    }

    const page = await store.documentHistoryPageSnapshot(slug, 1);
    expect(page.history).toHaveLength(105);
    expect(page.history.every((entry) => entry.retained)).toBe(true);
    expect(page.active?.markdown).toBe("version 0");
  });

  it("an unknown slug has no history", async () => {
    const store = freshProject();
    expect(await store.documentHistory(docSlug("nope"))).toEqual([]);
  });
});
