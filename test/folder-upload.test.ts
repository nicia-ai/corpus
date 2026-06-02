import { describe, expect, it } from "vitest";

import { docSlug, freshStore } from "./_helpers";

const freshProject = () => freshStore("upload");
const by = "uploader";

describe("bulk folder upload — importDocumentAtPath (one atomic tx each)", () => {
  it("a fresh path creates ancestor folders + the document", async () => {
    const store = freshProject();
    const r = await store.importDocumentAtPath({
      path: "guide/setup/intro.md",
      markdown: "# Intro\nwelcome",
      changedBy: by,
    });
    expect(r).toEqual({
      ok: true,
      slug: "guide-setup-intro",
      docVersion: 1,
      created: true,
    });

    const folders = await store.listFolders();
    const byName = new Map(folders.map((f) => [f.name, f]));
    expect(folders).toHaveLength(2);
    expect(byName.get("guide")?.parentSlug).toBe(null);
    expect(byName.get("setup")?.parentSlug).toBe(byName.get("guide")?.slug);

    const head = await store.getDocument(docSlug("guide-setup-intro"));
    expect(head?.markdown).toContain("welcome");
    expect(head?.docVersion).toBe(1);
  });

  it("re-uploading the same path bumps the version (idempotent, no dup)", async () => {
    const store = freshProject();
    const first = await store.importDocumentAtPath({
      path: "a/b/note.md",
      markdown: "v1",
      changedBy: by,
    });
    expect(first).toMatchObject({ ok: true, docVersion: 1, created: true });

    const second = await store.importDocumentAtPath({
      path: "a/b/note.md",
      markdown: "v2",
      changedBy: by,
    });
    expect(second).toEqual({
      ok: true,
      slug: "a-b-note",
      docVersion: 2,
      created: false,
    });

    expect(await store.listDocumentSlugs()).toEqual(["a-b-note"]);
    expect(await store.versionCount(docSlug("a-b-note"))).toBe(2);
    expect((await store.getDocument(docSlug("a-b-note")))?.markdown).toBe("v2");
    // Folders reused by name, not recreated.
    expect(await store.listFolders()).toHaveLength(2);
  });

  it("sibling files reuse the same ancestor folders by name", async () => {
    const store = freshProject();
    await store.importDocumentAtPath({
      path: "docs/api/auth.md",
      markdown: "auth",
      changedBy: by,
    });
    await store.importDocumentAtPath({
      path: "docs/api/users.md",
      markdown: "users",
      changedBy: by,
    });
    const folders = await store.listFolders();
    expect(folders.map((f) => f.name).sort()).toEqual(["api", "docs"]);
    expect(await store.listDocumentSlugs()).toEqual(
      expect.arrayContaining(["docs-api-auth", "docs-api-users"]),
    );
  });

  it("batch import reports created / updated / failed", async () => {
    const store = freshProject();
    const summary = await store.importDocuments(
      [
        { path: "p/one.md", markdown: "1" },
        { path: "p/two.md", markdown: "2" },
        { path: "p/one.md", markdown: "1b" },
      ],
      by,
    );
    expect(summary).toEqual({ created: 2, updated: 1, failed: [] });
    expect(await store.listFolders()).toHaveLength(1);
  });
});

describe("bulk folder upload — segment collisions roll back atomically", () => {
  it("a directory segment colliding with an existing document is rejected, nothing written", async () => {
    const store = freshProject();
    await store.importDocumentAtPath({
      path: "notes.md",
      markdown: "# Notes",
      changedBy: by,
    });
    const r = await store.importDocumentAtPath({
      path: "notes.md/inner.md",
      markdown: "inner",
      changedBy: by,
    });
    expect(r).toEqual({ ok: false, reason: "segment-collision" });
    // No folder created, no inner doc — original doc untouched.
    expect(await store.listFolders()).toHaveLength(0);
    expect(await store.listDocumentSlugs()).toEqual(["notes"]);
  });

  it("a file whose name collides with a sibling folder rolls back the half-written document", async () => {
    const store = freshProject();
    const f = await store.createFolder("foo", null);
    expect(f.ok).toBe(true);

    const r = await store.importDocumentAtPath({
      path: "foo",
      markdown: "would shadow the folder",
      changedBy: by,
    });
    expect(r).toEqual({ ok: false, reason: "segment-collision" });

    // saveDocumentBody ran before placement failed; the throw must have
    // rolled the whole unit back — no document, no version, no blob.
    expect(await store.listDocumentSlugs()).toEqual([]);
    expect(await store.versionCount(docSlug("foo"))).toBe(0);
    expect(await store.getDocument(docSlug("foo"))).toBeUndefined();
    expect(await store.listFolders()).toHaveLength(1);
  });
});
