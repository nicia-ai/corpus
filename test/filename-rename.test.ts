import { describe, expect, it } from "vitest";

import { asFolderSlug, type FolderSlug } from "../src/ids";

import { colSlug, docSlug, freshStore } from "./_helpers";

const by = "u";
const CORPUS = colSlug("docs");

// Every document lives in a corpus, so each workspace starts with one.
async function freshWorkspace() {
  const w = freshStore("fname");
  await w.createCorpus({ slug: CORPUS, name: "Docs", changedBy: by });
  return w;
}

type Workspace = Awaited<ReturnType<typeof freshWorkspace>>;

const importAt = (
  w: Workspace,
  path: string,
  markdown: string,
  changedBy = by,
) => w.importDocumentAtPath({ corpusSlug: CORPUS, path, markdown, changedBy });

async function folderSlug(store: Workspace, name: string): Promise<FolderSlug> {
  const f = (await store.listFolders()).find((x) => x.name === name);
  if (f === undefined) throw new Error(`folder ${name} not found`);
  return asFolderSlug(f.slug);
}

const countReordered = async (store: Workspace): Promise<number> =>
  (await store.recentChanges(100)).filter(
    (e) => e.eventType === "collection.reordered",
  ).length;

// `filename` rename is a FIRST-CLASS op (DO method + distinct event),
// not a widening of the title-only `renameDocument`. It is head-only
// (no blob / DocumentVersion / docVersion bump) but, unlike a title
// rename, it is a path-map mutation and so re-notifies the document's corpus
// tree.
describe("renameFilename — head-only, distinct event", () => {
  it("changes filename without touching the content-addressed chain", async () => {
    const w = await freshWorkspace();
    const r1 = await importAt(w, "a/notes.md", "# N v1", "alice");
    if (!r1.ok) throw new Error("import failed");
    const slug = docSlug(r1.slug);
    await importAt(w, "a/notes.md", "# N v2", "bob");
    expect((await w.getDocument(slug))?.docVersion).toBe(2);
    expect(await w.versionCount(slug)).toBe(2);

    const r = await w.renameFilename({
      slug,
      filename: "renamed.md",
      changedBy: "carol",
    });
    expect(r).toEqual({ ok: true });

    const after = await w.getDocument(slug);
    expect(after?.filename).toBe("renamed.md");
    expect(after?.docVersion).toBe(2);
    expect(after?.markdown).toBe("# N v2");
    expect(await w.versionCount(slug)).toBe(2);
    expect(await w.verifyHistory(slug)).toEqual({ ok: true });
  });

  it("emits a distinct document.filename_changed event", async () => {
    const w = await freshWorkspace();
    const r1 = await importAt(w, "policy.md", "# Policy");
    if (!r1.ok) throw new Error("import failed");
    await w.renameFilename({
      slug: docSlug(r1.slug),
      filename: "policy-v2.md",
      changedBy: "dave",
    });
    const changes = await w.recentChanges(10);
    expect(
      changes.find((e) => e.eventType === "document.filename_changed"),
    ).toMatchObject({
      documentSlug: r1.slug,
      changedBy: "dave",
    });
  });

  it("an unchanged filename is an idempotent no-op (no event)", async () => {
    const w = await freshWorkspace();
    const r1 = await importAt(w, "icp.md", "# ICP");
    if (!r1.ok) throw new Error("import failed");
    const evtId = await w.lastEventId();
    expect(
      await w.renameFilename({
        slug: docSlug(r1.slug),
        filename: "icp.md",
        changedBy: by,
      }),
    ).toEqual({ ok: true });
    expect(await w.lastEventId()).toBe(evtId);
  });
});

describe("renameFilename — cross-type sibling-namespace collision", () => {
  it("rejects a doc-vs-doc clash in the same folder", async () => {
    const w = await freshWorkspace();
    await importAt(w, "docs/a.md", "# A");
    const rb = await importAt(w, "docs/b.md", "# B");
    if (!rb.ok) throw new Error("import failed");
    expect(
      await w.renameFilename({
        slug: docSlug(rb.slug),
        filename: "a.md",
        changedBy: by,
      }),
    ).toEqual({ ok: false, reason: "segment-collision" });
    expect((await w.getDocument(docSlug(rb.slug)))?.filename).toBe("b.md");
  });

  it("rejects a doc-vs-folder clash at the corpus root", async () => {
    const w = await freshWorkspace();
    // Creates a root folder named `guide`.
    await importAt(w, "guide/intro.md", "# Intro");
    const rr = await importAt(w, "readme.md", "# Readme");
    if (!rr.ok) throw new Error("import failed");
    expect(
      await w.renameFilename({
        slug: docSlug(rr.slug),
        filename: "guide",
        changedBy: by,
      }),
    ).toEqual({ ok: false, reason: "segment-collision" });
  });

  it("returns missing for an unknown document", async () => {
    const w = await freshWorkspace();
    expect(
      await w.renameFilename({
        slug: docSlug("ghost"),
        filename: "x.md",
        changedBy: by,
      }),
    ).toEqual({ ok: false, reason: "missing" });
  });
});

describe("renameFilename — corpus tree fan-out (title rename does NOT)", () => {
  it("re-notifies the document's corpus tree; renameDocument does not", async () => {
    const w = await freshWorkspace();
    const rs = await importAt(w, "team/setup.md", "# Setup");
    if (!rs.ok) throw new Error("import failed");
    await importAt(w, "team/other.md", "# Other");
    expect(await folderSlug(w, "team")).toBeDefined();

    const base = await countReordered(w);

    // Title rename is display-only → NOT a path-map mutation.
    await w.renameDocument({
      slug: docSlug(rs.slug),
      title: "Setup Guide",
      changedBy: by,
    });
    expect(await countReordered(w)).toBe(base);

    // Filename rename shifts the path map → exactly one tree-change event
    // for the document's corpus, plus the distinct doc event.
    await w.renameFilename({
      slug: docSlug(rs.slug),
      filename: "setup-guide.md",
      changedBy: by,
    });
    expect(await countReordered(w)).toBe(base + 1);
    expect(
      (await w.recentChanges(5)).some(
        (e) => e.eventType === "document.filename_changed",
      ),
    ).toBe(true);
  });
});
