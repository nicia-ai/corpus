import { describe, expect, it } from "vitest";

import { asFolderSlug, type FolderSlug } from "../src/ids";

import { colSlug, docSlug, freshStore } from "./_helpers";

const ws = () => freshStore("flink");
const by = "u";

async function folderSlug(
  store: ReturnType<typeof ws>,
  name: string,
): Promise<FolderSlug> {
  const f = (await store.listFolders()).find((x) => x.name === name);
  if (f === undefined) throw new Error(`folder ${name} not found`);
  return asFolderSlug(f.slug);
}

// setup.md (in a/guide) links every flavour of relative target, plus
// Obsidian-style wikilinks (bare-name, piped, and dangling).
const SETUP = [
  "[auth](../api/auth.md)",
  "[self](./intro.md)",
  "[up](../../top.md)",
  "[deep](../api/v2/spec.md)",
  "[ext](https://example.com)",
  "[anchor](#section)",
  "[missing](./ghost.md)",
  "[[auth|the auth doc]]",
  "[[top]]",
  "[[nowhere]]",
].join("\n\n");

async function build(store: ReturnType<typeof ws>) {
  await store.importDocumentAtPath({
    path: "a/guide/setup.md",
    markdown: SETUP,
    changedBy: by,
  });
  await store.importDocumentAtPath({
    path: "a/guide/intro.md",
    markdown: "# Intro",
    changedBy: by,
  });
  await store.importDocumentAtPath({
    path: "a/api/auth.md",
    markdown: "# Auth",
    changedBy: by,
  });
  await store.importDocumentAtPath({
    path: "a/api/v2/spec.md",
    markdown: "# Spec",
    changedBy: by,
  });
  // Root doc — exists, but NOT under folder `a` (out of the collection).
  await store.importDocumentAtPath({
    path: "top.md",
    markdown: "# Top",
    changedBy: by,
  });
  await store.createCollection({
    slug: colSlug("k"),
    name: "K",
    changedBy: by,
  });
  await store.attachFolderToCollection(
    colSlug("k"),
    await folderSlug(store, "a"),
    1,
    by,
  );
}

function linksOf(
  outline: Awaited<ReturnType<ReturnType<typeof ws>["collectionOutline"]>>,
  slug: string,
) {
  if (!outline.found) throw new Error("collection not found");
  const d = outline.documents.find((x) => x.slug === slug);
  if (d === undefined) throw new Error(`doc ${slug} not in outline`);
  return { doc: d, byTarget: new Map(d.links.map((l) => [l.target, l])) };
}

describe("collectionOutline — derived paths + resolved link graph", () => {
  it("projects tree-ordered docs with derived paths", async () => {
    const w = ws();
    await build(w);
    const o = await w.collectionOutline(colSlug("k"));
    expect(o.found).toBe(true);
    if (!o.found) return;
    const paths = new Map(o.documents.map((d) => [d.slug, d.path]));
    expect(paths.get("a-guide-setup")).toBe("a/guide/setup.md");
    expect(paths.get("a-api-v2-spec")).toBe("a/api/v2/spec.md");
  });

  it("resolves every relative link flavour; external/anchor are not links", async () => {
    const w = ws();
    await build(w);
    const o = await w.collectionOutline(colSlug("k"));
    const { doc, byTarget } = linksOf(o, "a-guide-setup");

    // External + pure anchor never enter the link set.
    expect(doc.links.map((l) => l.target)).toEqual([
      "../api/auth.md",
      "./intro.md",
      "../../top.md",
      "../api/v2/spec.md",
      "./ghost.md",
      "auth",
      "top",
      "nowhere",
    ]);

    expect(byTarget.get("../api/auth.md")).toEqual({
      target: "../api/auth.md",
      kind: "path",
      resolvedPath: "a/api/auth.md",
      documentSlug: "a-api-auth",
      inCollection: true,
    });
    expect(byTarget.get("./intro.md")?.documentSlug).toBe("a-guide-intro");
    expect(byTarget.get("../api/v2/spec.md")?.documentSlug).toBe(
      "a-api-v2-spec",
    );

    // Resolves to a real document that is OUTSIDE this collection.
    expect(byTarget.get("../../top.md")).toEqual({
      target: "../../top.md",
      kind: "path",
      resolvedPath: "top.md",
      documentSlug: "top",
      inCollection: false,
    });

    // Dangling: resolves to a path with no document.
    expect(byTarget.get("./ghost.md")).toEqual({
      target: "./ghost.md",
      kind: "path",
      resolvedPath: "a/guide/ghost.md",
      documentSlug: null,
      inCollection: false,
    });

    // Wikilinks resolve by basename anywhere in the project…
    expect(byTarget.get("auth")).toEqual({
      target: "auth",
      kind: "wiki",
      resolvedPath: "a/api/auth.md",
      documentSlug: "a-api-auth",
      inCollection: true,
    });
    // …including targets outside this collection…
    expect(byTarget.get("top")).toEqual({
      target: "top",
      kind: "wiki",
      resolvedPath: "top.md",
      documentSlug: "top",
      inCollection: false,
    });
    // …and dangle with no resolved path when nothing matches.
    expect(byTarget.get("nowhere")).toEqual({
      target: "nowhere",
      kind: "wiki",
      resolvedPath: null,
      documentSlug: null,
      inCollection: false,
    });
  });

  it("a title rename leaves path + link resolution unchanged", async () => {
    const w = ws();
    await build(w);
    await w.renameDocument({
      slug: docSlug("a-api-auth"),
      title: "Renamed Auth",
      changedBy: by,
    });
    const o = await w.collectionOutline(colSlug("k"));
    const { byTarget } = linksOf(o, "a-guide-setup");
    expect(byTarget.get("../api/auth.md")).toEqual({
      target: "../api/auth.md",
      kind: "path",
      resolvedPath: "a/api/auth.md",
      documentSlug: "a-api-auth",
      inCollection: true,
    });
  });

  it("moving a target document re-points resolution (bytes unchanged)", async () => {
    const w = ws();
    await build(w);
    // Move intro.md out of a/guide into folder `a` → path becomes a/intro.md.
    const placed = await w.placeDocumentInFolder(
      docSlug("a-guide-intro"),
      await folderSlug(w, "a"),
      by,
    );
    expect(placed.ok).toBe(true);

    const o = await w.collectionOutline(colSlug("k"));
    const { byTarget } = linksOf(o, "a-guide-setup");
    // setup.md still says "./intro.md" verbatim, but that path is now
    // empty (intro lives at a/intro.md) → the link dangles.
    expect(byTarget.get("./intro.md")).toEqual({
      target: "./intro.md",
      kind: "path",
      resolvedPath: "a/guide/intro.md",
      documentSlug: null,
      inCollection: false,
    });
    // The moved document is still present at its new path.
    const moved = o.found
      ? o.documents.find((d) => d.slug === "a-guide-intro")
      : undefined;
    expect(moved?.path).toBe("a/intro.md");
  });

  it("an unknown collection has no outline", async () => {
    const w = ws();
    expect(await w.collectionOutline(colSlug("nope"))).toEqual({
      found: false,
    });
  });
});
