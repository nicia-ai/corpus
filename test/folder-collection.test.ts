import { describe, expect, it } from "vitest";

import { asFolderSlug } from "../src/ids";

import { colSlug, docSlug, freshStore } from "./_helpers";

const ws = () => freshStore("fcol");
const by = "u";

async function folderSlugByName(
  store: ReturnType<typeof ws>,
  name: string,
): Promise<string> {
  const f = (await store.listFolders()).find((x) => x.name === name);
  if (f === undefined) throw new Error(`folder ${name} not found`);
  return f.slug;
}

describe("folder→collection links — shared resolver expansion", () => {
  it("a linked folder expands into the collection (docs by filename, then subfolders)", async () => {
    const w = ws();
    await w.importDocumentAtPath({
      path: "a/b/zeta.md",
      markdown: "z",
      changedBy: by,
    });
    await w.importDocumentAtPath({
      path: "a/b/alpha.md",
      markdown: "a",
      changedBy: by,
    });
    await w.createCollection({
      slug: colSlug("c1"),
      name: "C1",
      changedBy: by,
    });
    const b = await folderSlugByName(w, "b");

    expect((await w.attachFolderToCollection(colSlug("c1"), b, 1, by)).ok).toBe(
      true,
    );

    const r = await w.readCollection(colSlug("c1"));
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.documents.map((d) => d.slug)).toEqual(["a-b-alpha", "a-b-zeta"]);
  });

  it("direct docs and a folder interleave by the shared position space, first occurrence wins", async () => {
    const w = ws();
    await w.importDocumentAtPath({
      path: "a/b/zeta.md",
      markdown: "z",
      changedBy: by,
    });
    await w.importDocumentAtPath({
      path: "a/b/alpha.md",
      markdown: "a",
      changedBy: by,
    });
    await w.createCollection({
      slug: colSlug("c2"),
      name: "C2",
      changedBy: by,
    });
    const b = await folderSlugByName(w, "b");

    // zeta also included directly at position 1 (before the folder).
    await w.attachDocument(colSlug("c2"), docSlug("a-b-zeta"), 1, by);
    await w.attachFolderToCollection(colSlug("c2"), b, 2, by);

    const r = await w.readCollection(colSlug("c2"));
    if (!r.found) return;
    // zeta first (direct, pos 1); folder expands alpha (zeta deduped).
    expect(r.documents.map((d) => d.slug)).toEqual(["a-b-zeta", "a-b-alpha"]);
  });

  it("the link is live: a doc later added to the folder appears without re-attaching", async () => {
    const w = ws();
    await w.importDocumentAtPath({
      path: "a/b/zeta.md",
      markdown: "z",
      changedBy: by,
    });
    await w.importDocumentAtPath({
      path: "a/b/alpha.md",
      markdown: "a",
      changedBy: by,
    });
    await w.createCollection({
      slug: colSlug("c3"),
      name: "C3",
      changedBy: by,
    });
    const b = await folderSlugByName(w, "b");
    await w.attachFolderToCollection(colSlug("c3"), b, 1, by);

    await w.importDocumentAtPath({
      path: "a/b/mid.md",
      markdown: "m",
      changedBy: by,
    });

    const r = await w.readCollection(colSlug("c3"));
    if (!r.found) return;
    expect(r.documents.map((d) => d.slug)).toEqual([
      "a-b-alpha",
      "a-b-mid",
      "a-b-zeta",
    ]);
  });

  it("linking an ancestor folder includes the whole subtree; moving a subfolder out removes its docs", async () => {
    const w = ws();
    await w.importDocumentAtPath({
      path: "a/top.md",
      markdown: "t",
      changedBy: by,
    });
    await w.importDocumentAtPath({
      path: "a/b/deep.md",
      markdown: "d",
      changedBy: by,
    });
    await w.createCollection({
      slug: colSlug("c4"),
      name: "C4",
      changedBy: by,
    });
    const a = await folderSlugByName(w, "a");
    const b = await folderSlugByName(w, "b");
    await w.attachFolderToCollection(colSlug("c4"), a, 1, by);

    let r = await w.readCollection(colSlug("c4"));
    if (!r.found) return;
    expect(r.documents.map((d) => d.slug).sort()).toEqual([
      "a-b-deep",
      "a-top",
    ]);

    // Move b out to root → it leaves a's subtree.
    expect((await w.moveFolder(b, null, by)).ok).toBe(true);
    r = await w.readCollection(colSlug("c4"));
    if (!r.found) return;
    expect(r.documents.map((d) => d.slug)).toEqual(["a-top"]);
  });

  it("detach removes the folder's contribution", async () => {
    const w = ws();
    await w.importDocumentAtPath({
      path: "a/b/x.md",
      markdown: "x",
      changedBy: by,
    });
    await w.createCollection({
      slug: colSlug("c5"),
      name: "C5",
      changedBy: by,
    });
    const b = await folderSlugByName(w, "b");
    await w.attachFolderToCollection(colSlug("c5"), b, 1, by);
    expect((await w.detachFolderFromCollection(colSlug("c5"), b, by)).ok).toBe(
      true,
    );
    const r = await w.readCollection(colSlug("c5"));
    if (!r.found) return;
    expect(r.documents).toEqual([]);
  });

  it("a folder linked by a collection can still be deleted (inbound link released)", async () => {
    const w = ws();
    await w.importDocumentAtPath({
      path: "a/b/x.md",
      markdown: "x",
      changedBy: by,
    });
    await w.createCollection({
      slug: colSlug("c7"),
      name: "C7",
      changedBy: by,
    });
    const b = await folderSlugByName(w, "b");
    await w.attachFolderToCollection(colSlug("c7"), b, 1, by);

    // Must not roll back on the dangling includes_folder edge.
    expect((await w.deleteFolder(b, by)).ok).toBe(true);
    expect((await w.listFolders()).some((f) => f.slug === b)).toBe(false);
    const r = await w.readCollection(colSlug("c7"));
    if (!r.found) return;
    // x is archived with the folder and the collection's folder link
    // is gone, so the collection now resolves to nothing.
    expect(r.documents).toEqual([]);
  });

  it("a collection with only direct documents is unchanged (fast path)", async () => {
    const w = ws();
    for (const s of ["alpha", "bravo"]) {
      await w.saveDocument({
        slug: docSlug(s),
        markdown: `# ${s}`,
        clientVersion: 0,
        changedBy: by,
      });
    }
    await w.createCollection({
      slug: colSlug("c6"),
      name: "C6",
      changedBy: by,
    });
    await w.attachDocument(colSlug("c6"), docSlug("bravo"), 2, by);
    await w.attachDocument(colSlug("c6"), docSlug("alpha"), 1, by);
    const r = await w.readCollection(colSlug("c6"));
    if (!r.found) return;
    expect(r.documents.map((d) => d.slug)).toEqual(["alpha", "bravo"]);
  });
});

describe("deleteFolder — cascade", () => {
  it("deletes the folder and its whole subtree, including a same-named child", async () => {
    const w = ws();
    const outer = await w.createFolder("inner", null);
    expect(outer.ok).toBe(true);
    if (!outer.ok) return;
    // A nested folder with the SAME name as its parent — this used to
    // falsely block deletion via a re-home name clash; cascade just
    // removes the whole subtree.
    expect((await w.createFolder("inner", asFolderSlug(outer.slug))).ok).toBe(
      true,
    );

    const r = await w.deleteFolder(asFolderSlug(outer.slug), by);
    expect(r.ok).toBe(true);
    expect(await w.listFolders()).toEqual([]);
  });

  it("archives the documents in the deleted subtree (not re-homed to root)", async () => {
    const w = ws();
    await w.importDocumentAtPath({
      path: "docs/sub/note.md",
      markdown: "# Note",
      changedBy: by,
    });
    const sub = await folderSlugByName(w, "sub");
    expect((await w.deleteFolder(sub, by)).ok).toBe(true);
    // The subfolder is gone and its document is archived — absent from
    // the live list, never surfaced at root.
    expect((await w.listFolders()).some((f) => f.name === "sub")).toBe(false);
    expect((await w.listDocuments()).map((d) => d.slug)).toEqual([]);
  });
});

describe("placeDocumentsInFolder — bulk move", () => {
  it("moves every selected document into one folder in a single call", async () => {
    const w = ws();
    for (const s of ["alpha", "bravo", "charlie"]) {
      await w.saveDocument({
        slug: docSlug(s),
        markdown: `# ${s}`,
        clientVersion: 0,
        changedBy: by,
      });
    }
    const dest = await w.createFolder("dest", null);
    expect(dest.ok).toBe(true);
    if (!dest.ok) return;

    const r = await w.placeDocumentsInFolder(
      [docSlug("alpha"), docSlug("bravo")],
      asFolderSlug(dest.slug),
      by,
    );
    expect(r.moved).toBe(2);
    expect(r.failed).toBe(0);

    const byFolder = new Map(
      (await w.listDocuments()).map((d) => [d.slug, d.folderSlug]),
    );
    expect(byFolder.get("alpha")).toBe(dest.slug);
    expect(byFolder.get("bravo")).toBe(dest.slug);
    expect(byFolder.get("charlie")).toBe(null);
  });

  // Regression: in a folder-linked collection, a direct member's resolved
  // index (what collectionStructure exposes as `position`) is NOT its stored
  // includes-edge position. Flipping its delivery tier must NOT round-trip
  // that resolved index back into the edge position — doing so reordered
  // direct members relative to each other.
  it("flipping a direct member's delivery tier preserves member order", async () => {
    const w = ws();
    // Folder `b` expands to alpha, zeta (by filename), at edge position 1.
    await w.importDocumentAtPath({
      path: "a/b/zeta.md",
      markdown: "z",
      changedBy: by,
    });
    await w.importDocumentAtPath({
      path: "a/b/alpha.md",
      markdown: "a",
      changedBy: by,
    });
    // Two direct docs after the folder, at edge positions 2 and 3.
    await w.saveDocument({
      slug: docSlug("mid"),
      markdown: "# mid",
      clientVersion: 0,
      changedBy: by,
    });
    await w.saveDocument({
      slug: docSlug("last"),
      markdown: "# last",
      clientVersion: 0,
      changedBy: by,
    });
    await w.createCollection({ slug: colSlug("c"), name: "C", changedBy: by });
    const b = await folderSlugByName(w, "b");

    await w.attachFolderToCollection(colSlug("c"), b, 1, by);
    await w.attachDocument(colSlug("c"), docSlug("mid"), 2, by);
    await w.attachDocument(colSlug("c"), docSlug("last"), 3, by);

    const before = await w.collectionStructure(colSlug("c"));
    expect(before.found).toBe(true);
    if (!before.found) return;
    const orderBefore = before.members.map((m) => m.slug);
    // Resolved: folder docs first, then the two direct docs in edge order.
    expect(orderBefore).toEqual(["a-b-alpha", "a-b-zeta", "mid", "last"]);

    // `mid`'s collectionStructure position is its resolved index (3), not its
    // stored edge position (2) — the trap the old toggle fell into.
    expect(before.members.find((m) => m.slug === "mid")?.position).toBe(3);

    const flip = await w.setMemberDelivery(
      colSlug("c"),
      docSlug("mid"),
      "reference",
      by,
    );
    expect(flip.ok).toBe(true);

    const after = await w.collectionStructure(colSlug("c"));
    if (!after.found) return;
    // Order is byte-for-byte unchanged; only `mid`'s tier flipped.
    expect(after.members.map((m) => m.slug)).toEqual(orderBefore);
    expect(after.members.find((m) => m.slug === "mid")?.delivery).toBe(
      "reference",
    );
    expect(after.members.find((m) => m.slug === "last")?.delivery).toBe("core");

    // Idempotent: flipping to the same tier is a no-op.
    const noop = await w.setMemberDelivery(
      colSlug("c"),
      docSlug("mid"),
      "reference",
      by,
    );
    expect(noop.ok).toBe(false);

    // read_collection now ships only the core members, still in order.
    const read = await w.readCollection(colSlug("c"));
    if (!read.found) return;
    expect(read.documents.map((d) => d.slug)).toEqual([
      "a-b-alpha",
      "a-b-zeta",
      "last",
    ]);
  });

  // Regression: direct-document reorder used to renumber direct edges to
  // 1..n, crossing any folder link that shared the same position space.
  // Reorder should use the existing direct slots and leave folder anchors
  // where they are.
  it("reordering direct members preserves folder-link positions", async () => {
    const w = ws();
    await w.importDocumentAtPath({
      path: "a/b/zeta.md",
      markdown: "z",
      changedBy: by,
    });
    await w.importDocumentAtPath({
      path: "a/b/alpha.md",
      markdown: "a",
      changedBy: by,
    });
    await w.saveDocument({
      slug: docSlug("mid"),
      markdown: "# mid",
      clientVersion: 0,
      changedBy: by,
    });
    await w.saveDocument({
      slug: docSlug("last"),
      markdown: "# last",
      clientVersion: 0,
      changedBy: by,
    });
    await w.createCollection({ slug: colSlug("r"), name: "R", changedBy: by });
    const b = await folderSlugByName(w, "b");
    await w.attachFolderToCollection(colSlug("r"), b, 1, by);
    await w.attachDocument(colSlug("r"), docSlug("mid"), 2, by);
    await w.attachDocument(colSlug("r"), docSlug("last"), 3, by);

    const reorder = await w.reorderCollectionDocuments(
      colSlug("r"),
      [docSlug("last"), docSlug("mid")],
      by,
    );
    expect(reorder.ok).toBe(true);

    const after = await w.collectionStructure(colSlug("r"));
    if (!after.found) return;
    expect(after.members.map((m) => m.slug)).toEqual([
      "a-b-alpha",
      "a-b-zeta",
      "last",
      "mid",
    ]);
  });

  // Regression: an explicit direct `reference` membership must NOT be
  // promoted to `core` just because the same document is also reachable
  // through a folder linked as `core`. The direct choice is authoritative.
  it("a direct reference member is not promoted by a core folder", async () => {
    const w = ws();
    await w.importDocumentAtPath({
      path: "a/b/note.md",
      markdown: "n",
      changedBy: by,
    });
    await w.createCollection({ slug: colSlug("d"), name: "D", changedBy: by });
    const b = await folderSlugByName(w, "b");

    // Folder linked as core (its docs would be core by inheritance)…
    await w.attachFolderToCollection(colSlug("d"), b, 1, by, "core");
    // …but the same doc is also a direct member, explicitly reference.
    await w.attachDocument(
      colSlug("d"),
      docSlug("a-b-note"),
      2,
      by,
      "reference",
    );

    const s = await w.collectionStructure(colSlug("d"));
    if (!s.found) return;
    expect(s.members.find((m) => m.slug === "a-b-note")?.delivery).toBe(
      "reference",
    );
    // Direct reference wins → excluded from read_collection's core corpus.
    const read = await w.readCollection(colSlug("d"));
    if (!read.found) return;
    expect(read.documents.map((d) => d.slug)).toEqual([]);
  });
});
