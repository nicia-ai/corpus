import { describe, expect, it } from "vitest";

import { colSlug, docSlug, freshStore } from "./_helpers";

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
      folderSlug: "setup",
      createdFolders: ["guide", "setup"],
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
      folderSlug: "b",
      // Folders reused by name on re-upload — nothing newly created.
      createdFolders: [],
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

// The link TARGET (the whole folder vs. the individual documents) is
// derived by the DO from what the import actually created — never from a
// client flag — so these assert behavior per upload shape. Uploads link
// as reference-tier, so membership is read via collectionMembers (the
// resolved set); readCollection.documents lists core-tier only.
describe("bulk folder upload — importDocumentsAndLink (derived link target)", () => {
  it("a loose file at the root links the document, not a folder", async () => {
    const store = freshProject();
    const r = await store.importDocumentsAndLink({
      entries: [{ path: "readme.md", markdown: "# R" }],
      link: { mode: "new", name: "Sales" },
      changedBy: by,
    });
    expect(r.summary).toEqual({ created: 1, updated: 0, failed: [] });
    expect(r.linkedTo).toBe("sales");
    // No wrapper folder synthesized for a single root-level file.
    expect(await store.listFolders()).toHaveLength(0);
    expect(await store.collectionMembers(colSlug("sales"))).toEqual(["readme"]);
  });

  it("links the uploaded documents to an existing collection, in upload order", async () => {
    const store = freshProject();
    await store.createCollection({
      slug: colSlug("team"),
      name: "Team",
      changedBy: by,
    });
    const r = await store.importDocumentsAndLink({
      entries: [
        { path: "one.md", markdown: "1" },
        { path: "two.md", markdown: "2" },
      ],
      link: { mode: "existing", slug: colSlug("team") },
      changedBy: by,
    });
    expect(r.linkedTo).toBe("team");
    expect(await store.collectionMembers(colSlug("team"))).toEqual([
      "one",
      "two",
    ]);
  });

  it("a fresh wrapper folder is linked live — later additions join too", async () => {
    const store = freshProject();
    const r = await store.importDocumentsAndLink({
      entries: [{ path: "guide/intro.md", markdown: "i" }],
      link: { mode: "new", name: "Docs" },
      changedBy: by,
    });
    expect(r.linkedTo).toBe("docs");

    // A document added to the freshly-created folder later is in the
    // collection automatically — the live-folder guarantee.
    await store.importDocumentAtPath({
      path: "guide/extra.md",
      markdown: "e",
      changedBy: by,
    });
    const members = await store.collectionMembers(colSlug("docs"));
    expect([...(members ?? [])].sort()).toEqual(["guide-extra", "guide-intro"]);
  });

  it("a fresh wrapper nested under an existing folder links the wrapper, not the parent", async () => {
    const store = freshProject();
    // Pre-existing `docs` folder with an unrelated document.
    await store.importDocumentAtPath({
      path: "docs/old.md",
      markdown: "o",
      changedBy: by,
    });
    // Upload creates a fresh `docs/proj` wrapper.
    const r = await store.importDocumentsAndLink({
      entries: [{ path: "docs/proj/a.md", markdown: "a" }],
      link: { mode: "new", name: "Proj" },
      changedBy: by,
    });
    expect(r.linkedTo).toBe("proj");

    // Only the fresh wrapper's subtree is linked — `docs/old.md` is not
    // pulled in — and it is live for later additions under `docs/proj`.
    await store.importDocumentAtPath({
      path: "docs/proj/b.md",
      markdown: "b",
      changedBy: by,
    });
    const members = await store.collectionMembers(colSlug("proj"));
    expect([...(members ?? [])].sort()).toEqual(["docs-proj-a", "docs-proj-b"]);
  });

  it("merging into a pre-existing folder links the documents, not the folder (not live)", async () => {
    const store = freshProject();
    await store.importDocumentAtPath({
      path: "docs/old.md",
      markdown: "o",
      changedBy: by,
    });
    const r = await store.importDocumentsAndLink({
      entries: [{ path: "docs/new.md", markdown: "n" }],
      link: { mode: "new", name: "Fresh" },
      changedBy: by,
    });
    expect(r.linkedTo).toBe("fresh");
    // The pre-existing sibling `docs/old.md` is NOT pulled in...
    expect(await store.collectionMembers(colSlug("fresh"))).toEqual([
      "docs-new",
    ]);
    // ...and the link is NOT live: a later addition to `docs` does not join.
    await store.importDocumentAtPath({
      path: "docs/another.md",
      markdown: "x",
      changedBy: by,
    });
    expect(await store.collectionMembers(colSlug("fresh"))).toEqual([
      "docs-new",
    ]);
  });

  it("re-uploading the same documents to the same collection adds no duplicates", async () => {
    const store = freshProject();
    await store.createCollection({
      slug: colSlug("team"),
      name: "Team",
      changedBy: by,
    });
    const link = { mode: "existing", slug: colSlug("team") } as const;
    await store.importDocumentsAndLink({
      entries: [{ path: "one.md", markdown: "1" }],
      link,
      changedBy: by,
    });
    // Re-upload (new version) and re-link to the same collection.
    const again = await store.importDocumentsAndLink({
      entries: [{ path: "one.md", markdown: "1b" }],
      link,
      changedBy: by,
    });
    expect(again.summary).toEqual({ created: 0, updated: 1, failed: [] });
    // attachMany's present-set dedup: the document stays a single member.
    expect(await store.collectionMembers(colSlug("team"))).toEqual(["one"]);
  });

  it("entries spanning more than one top folder link the documents", async () => {
    const store = freshProject();
    const r = await store.importDocumentsAndLink({
      entries: [
        { path: "a/x.md", markdown: "x" },
        { path: "b/y.md", markdown: "y" },
      ],
      link: { mode: "new", name: "Mixed" },
      changedBy: by,
    });
    expect(r.summary.created).toBe(2);
    expect(r.linkedTo).toBe("mixed");
    // No single fresh wrapper covers both, so the documents are linked.
    expect(
      [...((await store.collectionMembers(colSlug("mixed"))) ?? [])].sort(),
    ).toEqual(["a-x", "b-y"]);
  });
});
