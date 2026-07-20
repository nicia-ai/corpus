import { describe, expect, it } from "vitest";

import { asFolderSlug, type FolderSlug } from "../src/ids";

import { colSlug, docSlug, freshStore } from "./_helpers";

const ws = () => freshStore("fname");
const by = "u";

async function folderSlug(
  store: ReturnType<typeof ws>,
  name: string,
): Promise<FolderSlug> {
  const f = (await store.listFolders()).find((x) => x.name === name);
  if (f === undefined) throw new Error(`folder ${name} not found`);
  return asFolderSlug(f.slug);
}

const countReordered = async (store: ReturnType<typeof ws>): Promise<number> =>
  (await store.recentChanges(100)).filter(
    (e) => e.eventType === "collection.reordered",
  ).length;

// `filename` rename is a FIRST-CLASS op (DO method + distinct event),
// not a widening of the title-only `renameDocument`. It is head-only
// (no blob / DocumentVersion / docVersion bump) but, unlike a title
// rename, it is a path-map mutation and so fans out to folder-linking
// collections.
describe("renameFilename — head-only, distinct event", () => {
  it("changes filename without touching the content-addressed chain", async () => {
    const w = ws();
    const r1 = await w.importDocumentAtPath({
      path: "a/notes.md",
      markdown: "# N v1",
      changedBy: "alice",
    });
    if (!r1.ok) throw new Error("import failed");
    const slug = docSlug(r1.slug);
    await w.importDocumentAtPath({
      path: "a/notes.md",
      markdown: "# N v2",
      changedBy: "bob",
    });
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
    const w = ws();
    const r1 = await w.importDocumentAtPath({
      path: "policy.md",
      markdown: "# Policy",
      changedBy: by,
    });
    if (!r1.ok) throw new Error("import failed");
    await w.renameFilename({
      slug: docSlug(r1.slug),
      filename: "policy-v2.md",
      changedBy: "dave",
    });
    const [latest] = await w.recentChanges(1);
    expect(latest).toMatchObject({
      eventType: "document.filename_changed",
      documentSlug: r1.slug,
      changedBy: "dave",
    });
  });

  it("an unchanged filename is an idempotent no-op (no event)", async () => {
    const w = ws();
    const r1 = await w.importDocumentAtPath({
      path: "icp.md",
      markdown: "# ICP",
      changedBy: by,
    });
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
    const w = ws();
    await w.importDocumentAtPath({
      path: "docs/a.md",
      markdown: "# A",
      changedBy: by,
    });
    const rb = await w.importDocumentAtPath({
      path: "docs/b.md",
      markdown: "# B",
      changedBy: by,
    });
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

  it("rejects a doc-vs-folder clash at the root", async () => {
    const w = ws();
    // Creates a root folder named `guide`.
    await w.importDocumentAtPath({
      path: "guide/intro.md",
      markdown: "# Intro",
      changedBy: by,
    });
    const rr = await w.importDocumentAtPath({
      path: "readme.md",
      markdown: "# Readme",
      changedBy: by,
    });
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
    const w = ws();
    expect(
      await w.renameFilename({
        slug: docSlug("ghost"),
        filename: "x.md",
        changedBy: by,
      }),
    ).toEqual({ ok: false, reason: "missing" });
  });
});

describe("renameFilename — path-map fan-out (title rename does NOT)", () => {
  it("re-notifies folder-linking collections; renameDocument does not", async () => {
    const w = ws();
    const rs = await w.importDocumentAtPath({
      path: "team/setup.md",
      markdown: "# Setup",
      changedBy: by,
    });
    if (!rs.ok) throw new Error("import failed");
    await w.importDocumentAtPath({
      path: "team/other.md",
      markdown: "# Other",
      changedBy: by,
    });
    await w.createCollection({ slug: colSlug("k"), name: "K", changedBy: by });
    await w.attachFolderToCollection(
      colSlug("k"),
      await folderSlug(w, "team"),
      1,
      by,
    );

    const base = await countReordered(w);

    // Title rename is display-only → NOT a path-map mutation.
    await w.renameDocument({
      slug: docSlug(rs.slug),
      title: "Setup Guide",
      changedBy: by,
    });
    expect(await countReordered(w)).toBe(base);

    // Filename rename shifts the path map → exactly one fan-out event
    // for the single linking collection, plus the distinct doc event.
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
