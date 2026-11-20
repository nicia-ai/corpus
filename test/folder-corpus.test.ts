import { describe, expect, it } from "vitest";

import { asFolderSlug, type CorpusSlug } from "../src/ids";

import { colSlug, docSlug, freshStore } from "./_helpers";

const ws = () => freshStore("fcol");
const by = "u";
const KB: CorpusSlug = colSlug("kb");
const OTHER: CorpusSlug = colSlug("other");

async function freshKb(): Promise<ReturnType<typeof ws>> {
  const w = ws();
  await w.createCorpus({ slug: KB, name: "KB", changedBy: by });
  return w;
}

describe("deleteFolder — cascade", () => {
  it("deletes the folder and its whole subtree, including a same-named child", async () => {
    const w = await freshKb();
    const outer = await w.createFolder("inner", {
      corpusSlug: KB,
      folderSlug: null,
    });
    expect(outer.ok).toBe(true);
    if (!outer.ok) return;
    // A nested folder with the SAME name as its parent — this used to
    // falsely block deletion via a re-home name clash; cascade just
    // removes the whole subtree.
    expect(
      (
        await w.createFolder("inner", {
          corpusSlug: KB,
          folderSlug: asFolderSlug(outer.slug),
        })
      ).ok,
    ).toBe(true);

    const r = await w.deleteFolder(asFolderSlug(outer.slug), by);
    expect(r.ok).toBe(true);
    expect(await w.listFolders()).toEqual([]);
  });

  it("archives the documents in the deleted subtree (not re-homed to root)", async () => {
    const w = await freshKb();
    await w.importDocumentAtPath({
      corpusSlug: KB,
      path: "docs/sub/note.md",
      markdown: "# Note",
      changedBy: by,
    });
    const sub = await w
      .listFolders()
      .then((fs) => fs.find((f) => f.name === "sub"));
    if (sub === undefined) throw new Error("folder sub missing");
    expect((await w.deleteFolder(asFolderSlug(sub.slug), by)).ok).toBe(true);
    // The subfolder is gone and its document is archived — absent from
    // the live list, never surfaced at root.
    expect((await w.listFolders()).some((f) => f.name === "sub")).toBe(false);
    expect((await w.listDocuments()).map((d) => d.slug)).toEqual([]);
    expect(await w.corpusMembers(KB)).toEqual([]);
  });
});

describe("moveDocuments — bulk move", () => {
  it("moves every selected document into one folder in a single call", async () => {
    const w = await freshKb();
    for (const s of ["alpha", "bravo", "charlie"]) {
      await w.saveDocument({
        slug: docSlug(s),
        markdown: `# ${s}`,
        location: { corpusSlug: KB, folderSlug: null },
        clientVersion: 0,
        changedBy: by,
      });
    }
    const dest = await w.createFolder("dest", {
      corpusSlug: KB,
      folderSlug: null,
    });
    expect(dest.ok).toBe(true);
    if (!dest.ok) return;

    const r = await w.moveDocuments(
      [docSlug("alpha"), docSlug("bravo")],
      { corpusSlug: KB, folderSlug: asFolderSlug(dest.slug) },
      by,
    );
    expect(r).toEqual({ moved: 2, failed: 0 });

    const byFolder = new Map(
      (await w.listDocuments()).map((d) => [d.slug, d.folderSlug]),
    );
    expect(byFolder.get("alpha")).toBe(dest.slug);
    expect(byFolder.get("bravo")).toBe(dest.slug);
    expect(byFolder.get("charlie")).toBe(null);
  });

  it("moves documents from one corpus into another, where they are then served", async () => {
    const w = await freshKb();
    await w.createCorpus({ slug: OTHER, name: "Other", changedBy: by });
    await w.saveDocument({
      slug: docSlug("alpha"),
      markdown: "# alpha",
      location: { corpusSlug: KB, folderSlug: null },
      clientVersion: 0,
      changedBy: by,
    });

    const r = await w.moveDocuments(
      [docSlug("alpha")],
      { corpusSlug: OTHER, folderSlug: null },
      by,
    );
    expect(r).toEqual({ moved: 1, failed: 0 });
    expect(await w.corpusMembers(KB)).toEqual([]);
    expect(await w.corpusMembers(OTHER)).toEqual(["alpha"]);
  });
});

describe("listResolvedMembers — per-corpus document counts", () => {
  it("counts every live document once, in the corpus it is in", async () => {
    const w = await freshKb();
    await w.createCorpus({ slug: OTHER, name: "Other", changedBy: by });
    await w.importDocumentAtPath({
      corpusSlug: KB,
      path: "a/b/one.md",
      markdown: "1",
      changedBy: by,
    });
    await w.importDocumentAtPath({
      corpusSlug: KB,
      path: "a/b/two.md",
      markdown: "2",
      changedBy: by,
    });
    await w.importDocumentAtPath({
      corpusSlug: KB,
      path: "loose.md",
      markdown: "x",
      changedBy: by,
    });
    await w.importDocumentAtPath({
      corpusSlug: OTHER,
      path: "elsewhere.md",
      markdown: "e",
      changedBy: by,
    });

    const rows = await w.listResolvedMembers();
    expect(
      rows
        .filter((m) => m.corpusSlug === KB)
        .map((m) => m.documentSlug)
        .sort(),
    ).toEqual(["a-b-one", "a-b-two", "loose"]);
    expect(
      rows.filter((m) => m.corpusSlug === OTHER).map((m) => m.documentSlug),
    ).toEqual(["elsewhere"]);
    expect(rows).toHaveLength(4);
  });
});
