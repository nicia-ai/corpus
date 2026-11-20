import { describe, expect, it } from "vitest";

import { DEFAULT_CORPUS_SLUG } from "../src/store/domain/default-corpus";

import { colSlug, docSlug, freshStore } from "./_helpers";

const freshProject = () => freshStore("upload");
const by = "uploader";
const KB = colSlug("kb");
const TEAM = colSlug("team");
const DOCS = colSlug("docs");

// Every upload test works inside one corpus; the default corpus has its own
// describe below.
async function freshKb(): Promise<ReturnType<typeof freshProject>> {
  const store = freshProject();
  await store.createCorpus({ slug: KB, name: "KB", changedBy: by });
  return store;
}

describe("bulk folder upload — importDocumentAtPath (one atomic tx each)", () => {
  it("a fresh path creates ancestor folders + the document", async () => {
    const store = await freshKb();
    const r = await store.importDocumentAtPath({
      corpusSlug: KB,
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
    expect(folders.every((f) => f.corpusSlug === KB)).toBe(true);

    const head = await store.getDocument(docSlug("guide-setup-intro"));
    expect(head?.markdown).toContain("welcome");
    expect(head?.docVersion).toBe(1);
    expect(await store.documentLocation(docSlug("guide-setup-intro"))).toEqual({
      slug: "guide-setup-intro",
      corpusSlug: KB,
      path: "guide/setup/intro.md",
      folderSlug: byName.get("setup")?.slug,
    });
  });

  it("re-uploading the same path bumps the version (idempotent, no dup)", async () => {
    const store = await freshKb();
    const first = await store.importDocumentAtPath({
      corpusSlug: KB,
      path: "a/b/note.md",
      markdown: "v1",
      changedBy: by,
    });
    expect(first).toMatchObject({ ok: true, docVersion: 1, created: true });

    const second = await store.importDocumentAtPath({
      corpusSlug: KB,
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

    expect((await store.listDocumentRefs()).map((r) => r.slug)).toEqual([
      "a-b-note",
    ]);
    expect(await store.versionCount(docSlug("a-b-note"))).toBe(2);
    expect((await store.getDocument(docSlug("a-b-note")))?.markdown).toBe("v2");
    // Folders reused by name, not recreated.
    expect(await store.listFolders()).toHaveLength(2);
  });

  it("sibling files reuse the same ancestor folders by name", async () => {
    const store = await freshKb();
    await store.importDocumentAtPath({
      corpusSlug: KB,
      path: "docs/api/auth.md",
      markdown: "auth",
      changedBy: by,
    });
    await store.importDocumentAtPath({
      corpusSlug: KB,
      path: "docs/api/users.md",
      markdown: "users",
      changedBy: by,
    });
    const folders = await store.listFolders();
    expect(folders.map((f) => f.name).sort()).toEqual(["api", "docs"]);
    expect((await store.listDocumentRefs()).map((r) => r.slug)).toEqual(
      expect.arrayContaining(["docs-api-auth", "docs-api-users"]),
    );
  });

  it("an upload into a missing corpus is refused, nothing written", async () => {
    const store = freshProject();
    const r = await store.importDocumentAtPath({
      corpusSlug: colSlug("ghost"),
      path: "a.md",
      markdown: "a",
      changedBy: by,
    });
    expect(r).toEqual({ ok: false, reason: "missing-corpus" });
    expect(await store.listDocumentRefs()).toEqual([]);
  });
});

describe("bulk folder upload — segment collisions roll back atomically", () => {
  it("a directory segment colliding with an existing document is rejected, nothing written", async () => {
    const store = await freshKb();
    await store.importDocumentAtPath({
      corpusSlug: KB,
      path: "notes.md",
      markdown: "# Notes",
      changedBy: by,
    });
    const r = await store.importDocumentAtPath({
      corpusSlug: KB,
      path: "notes.md/inner.md",
      markdown: "inner",
      changedBy: by,
    });
    expect(r).toEqual({ ok: false, reason: "segment-collision" });
    // No folder created, no inner doc — original doc untouched.
    expect(await store.listFolders()).toHaveLength(0);
    expect((await store.listDocumentRefs()).map((r) => r.slug)).toEqual([
      "notes",
    ]);
  });

  it("a file whose name collides with a sibling folder rolls back the half-written document", async () => {
    const store = await freshKb();
    const f = await store.createFolder("foo", {
      corpusSlug: KB,
      folderSlug: null,
    });
    expect(f.ok).toBe(true);

    const r = await store.importDocumentAtPath({
      corpusSlug: KB,
      path: "foo",
      markdown: "would shadow the folder",
      changedBy: by,
    });
    expect(r).toEqual({ ok: false, reason: "segment-collision" });

    // The document write ran before placement failed; the throw must have
    // rolled the whole unit back — no document, no version, no blob.
    expect(await store.listDocumentRefs()).toEqual([]);
    expect(await store.versionCount(docSlug("foo"))).toBe(0);
    expect(await store.getDocument(docSlug("foo"))).toBeUndefined();
    expect(await store.listFolders()).toHaveLength(1);
  });
});

// Filename uniqueness is a per-folder sibling namespace (derived path =
// folder ancestry + filename), so the same filename may live in different
// folders. The import path must scope its brand-new-filename collision
// check to the document's target folder, not always the corpus root.
describe("bulk folder upload — filename collision is folder-scoped", () => {
  it("a folder-placed import may reuse a filename that a ROOT document holds", async () => {
    const store = await freshKb();
    await store.importDocumentAtPath({
      corpusSlug: KB,
      path: "index.md",
      markdown: "# Root index",
      changedBy: by,
    });

    // `wiki/index.md` lives in the `wiki` folder — a different sibling
    // namespace from the root `index.md`, so it must be accepted.
    const r = await store.importDocumentAtPath({
      corpusSlug: KB,
      path: "wiki/index.md",
      markdown: "# Wiki index",
      changedBy: by,
    });
    expect(r).toMatchObject({ ok: true, slug: "wiki-index", created: true });

    expect((await store.listDocumentRefs()).map((r) => r.slug).sort()).toEqual([
      "index",
      "wiki-index",
    ]);
    expect((await store.getDocument(docSlug("index")))?.markdown).toContain(
      "Root index",
    );
    expect(
      (await store.getDocument(docSlug("wiki-index")))?.markdown,
    ).toContain("Wiki index");
  });

  it("the same filename lands in two different folders", async () => {
    const store = await freshKb();
    const a = await store.importDocumentAtPath({
      corpusSlug: KB,
      path: "a/readme.md",
      markdown: "A",
      changedBy: by,
    });
    const b = await store.importDocumentAtPath({
      corpusSlug: KB,
      path: "b/readme.md",
      markdown: "B",
      changedBy: by,
    });
    expect(a).toMatchObject({ ok: true, slug: "a-readme" });
    expect(b).toMatchObject({ ok: true, slug: "b-readme" });
    expect((await store.listDocumentRefs()).map((r) => r.slug).sort()).toEqual([
      "a-readme",
      "b-readme",
    ]);
  });
});

// Destination modes: the default corpus (drafts), an existing corpus, or a
// new one named by the uploader. Paths are always relative to the corpus
// root the upload lands in.
describe("bulk folder upload — importIntoCorpus (destination modes)", () => {
  it("default mode lands in the drafts corpus and reports created / updated / failed", async () => {
    const store = freshProject();
    const result = await store.importIntoCorpus({
      entries: [
        { path: "p/one.md", markdown: "1" },
        { path: "p/two.md", markdown: "2" },
        { path: "p/one.md", markdown: "1b" },
      ],
      destination: { mode: "default" },
      changedBy: by,
    });
    expect(result).toEqual({
      summary: { created: 2, updated: 1, failed: [] },
      corpusSlug: DEFAULT_CORPUS_SLUG,
    });
    expect(await store.listFolders()).toHaveLength(1);
    expect(await store.corpusMembers(DEFAULT_CORPUS_SLUG)).toEqual([
      "p-one",
      "p-two",
    ]);
  });

  it("new mode creates the named corpus and links the readme at its root", async () => {
    const store = freshProject();
    const result = await store.importIntoCorpus({
      entries: [{ path: "readme.md", markdown: "# R" }],
      destination: { mode: "new", name: "Sales" },
      changedBy: by,
    });
    expect(result?.summary).toEqual({ created: 1, updated: 0, failed: [] });
    expect(result?.corpusSlug).toBe("sales");
    // No wrapper folder synthesized for a single root-level file.
    expect(await store.listFolders()).toHaveLength(0);
    expect(await store.corpusMembers(colSlug("sales"))).toEqual(["readme"]);
  });

  it("existing mode adds the uploaded documents to that corpus, in upload order", async () => {
    const store = freshProject();
    await store.createCorpus({ slug: TEAM, name: "Team", changedBy: by });
    const result = await store.importIntoCorpus({
      entries: [
        { path: "one.md", markdown: "1" },
        { path: "two.md", markdown: "2" },
      ],
      destination: { mode: "existing", slug: TEAM },
      changedBy: by,
    });
    expect(result?.corpusSlug).toBe(TEAM);
    expect(await store.corpusMembers(TEAM)).toEqual(["one", "two"]);
  });

  it("existing mode for a missing corpus imports nothing", async () => {
    const store = freshProject();
    const result = await store.importIntoCorpus({
      entries: [{ path: "one.md", markdown: "1" }],
      destination: { mode: "existing", slug: colSlug("gone") },
      changedBy: by,
    });
    expect(result).toBeUndefined();
    expect(await store.listDocumentRefs()).toEqual([]);
  });

  it("a nested upload into a new corpus holds only its own entries", async () => {
    const store = freshProject();
    // Another corpus already has `docs/old.md` at the same corpus-relative path.
    await store.createCorpus({ slug: TEAM, name: "Team", changedBy: by });
    await store.importDocumentAtPath({
      corpusSlug: TEAM,
      path: "docs/old.md",
      markdown: "o",
      changedBy: by,
    });
    const result = await store.importIntoCorpus({
      entries: [{ path: "docs/proj/a.md", markdown: "a" }],
      destination: { mode: "new", name: "Proj" },
      changedBy: by,
    });
    expect(result?.corpusSlug).toBe("proj");
    expect(await store.corpusMembers(colSlug("proj"))).toEqual(["docs-proj-a"]);
    expect(await store.corpusMembers(TEAM)).toEqual(["docs-old"]);
  });

  it("a later addition under the same folder joins the corpus", async () => {
    const store = freshProject();
    await store.importIntoCorpus({
      entries: [{ path: "guide/intro.md", markdown: "i" }],
      destination: { mode: "new", name: "Docs" },
      changedBy: by,
    });
    await store.importDocumentAtPath({
      corpusSlug: DOCS,
      path: "guide/extra.md",
      markdown: "e",
      changedBy: by,
    });
    expect([...((await store.corpusMembers(DOCS)) ?? [])].sort()).toEqual([
      "guide-extra",
      "guide-intro",
    ]);
  });

  it("re-uploading the same documents to the same corpus adds no duplicates", async () => {
    const store = freshProject();
    await store.createCorpus({ slug: TEAM, name: "Team", changedBy: by });
    const destination = { mode: "existing", slug: TEAM } as const;
    await store.importIntoCorpus({
      entries: [{ path: "one.md", markdown: "1" }],
      destination,
      changedBy: by,
    });
    // Re-upload (new version) to the same corpus.
    const again = await store.importIntoCorpus({
      entries: [{ path: "one.md", markdown: "1b" }],
      destination,
      changedBy: by,
    });
    expect(again?.summary).toEqual({ created: 0, updated: 1, failed: [] });
    expect(await store.corpusMembers(TEAM)).toEqual(["one"]);
  });

  it("entries spanning more than one top folder all land in the corpus", async () => {
    const store = freshProject();
    const result = await store.importIntoCorpus({
      entries: [
        { path: "a/x.md", markdown: "x" },
        { path: "b/y.md", markdown: "y" },
      ],
      destination: { mode: "new", name: "Mixed" },
      changedBy: by,
    });
    expect(result?.summary.created).toBe(2);
    expect(result?.corpusSlug).toBe("mixed");
    expect(
      [...((await store.corpusMembers(colSlug("mixed"))) ?? [])].sort(),
    ).toEqual(["a-x", "b-y"]);
  });
});
