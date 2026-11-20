import { describe, expect, it } from "vitest";

import { asFolderSlug, type CorpusSlug, type FolderSlug } from "../src/ids";

import { colSlug, docSlug, freshStore } from "./_helpers";

const ws = () => freshStore("flink");
const by = "u";
const K = colSlug("k");
const OTHER = colSlug("other");

async function folderSlug(
  store: ReturnType<typeof ws>,
  name: string,
): Promise<FolderSlug> {
  const f = (await store.listFolders()).find((x) => x.name === name);
  if (f === undefined) throw new Error(`folder ${name} not found`);
  return asFolderSlug(f.slug);
}

async function importAt(
  store: ReturnType<typeof ws>,
  corpusSlug: CorpusSlug,
  path: string,
  markdown: string,
): Promise<void> {
  const r = await store.importDocumentAtPath({
    corpusSlug,
    path,
    markdown,
    changedBy: by,
  });
  if (!r.ok) throw new Error(`import ${path} failed: ${r.reason}`);
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
  await store.createCorpus({ slug: K, name: "K", changedBy: by });
  await store.createCorpus({ slug: OTHER, name: "Other", changedBy: by });
  await importAt(store, K, "a/guide/setup.md", SETUP);
  await importAt(store, K, "a/guide/intro.md", "# Intro");
  await importAt(store, K, "a/api/auth.md", "# Auth");
  await importAt(store, K, "a/api/v2/spec.md", "# Spec");
  // Lives in another corpus: resolvable from K, but outside it.
  await importAt(store, OTHER, "top.md", "# Top");
}

function linksOf(
  outline: Awaited<ReturnType<ReturnType<typeof ws>["corpusOutline"]>>,
  slug: string,
) {
  if (!outline.found) throw new Error("corpus not found");
  const d = outline.documents.find((x) => x.slug === slug);
  if (d === undefined) throw new Error(`doc ${slug} not in outline`);
  return { doc: d, byTarget: new Map(d.links.map((l) => [l.target, l])) };
}

describe("corpusOutline — corpus-relative paths + resolved link graph", () => {
  it("lists the corpus's documents in path order with corpus-relative paths", async () => {
    const w = ws();
    await build(w);
    const o = await w.corpusOutline(K);
    expect(o.found).toBe(true);
    if (!o.found) return;
    expect(o.documents.map((d) => d.path)).toEqual([
      "a/api/auth.md",
      "a/api/v2/spec.md",
      "a/guide/intro.md",
      "a/guide/setup.md",
    ]);
    expect(o.documents.find((d) => d.slug === "a-guide-setup")?.path).toBe(
      "a/guide/setup.md",
    );
  });

  it("omits documents that live in another corpus", async () => {
    const w = ws();
    await build(w);
    const o = await w.corpusOutline(K);
    expect(o.found && o.documents.map((d) => d.slug)).not.toContain("top");
    expect(await w.corpusMembers(OTHER)).toEqual(["top"]);
  });

  it("resolves every relative link flavour; external/anchor are not links", async () => {
    const w = ws();
    await build(w);
    const o = await w.corpusOutline(K);
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
      inCorpus: true,
    });
    expect(byTarget.get("./intro.md")?.documentSlug).toBe("a-guide-intro");
    expect(byTarget.get("../api/v2/spec.md")?.documentSlug).toBe(
      "a-api-v2-spec",
    );

    // Resolves to a real document that is OUTSIDE this corpus.
    expect(byTarget.get("../../top.md")).toEqual({
      target: "../../top.md",
      kind: "path",
      resolvedPath: "top.md",
      documentSlug: "top",
      inCorpus: false,
    });

    // Dangling: no document at the path, so nothing resolves.
    expect(byTarget.get("./ghost.md")).toEqual({
      target: "./ghost.md",
      kind: "path",
      resolvedPath: null,
      documentSlug: null,
      inCorpus: false,
    });

    // Wikilinks resolve by basename inside this corpus first…
    expect(byTarget.get("auth")).toEqual({
      target: "auth",
      kind: "wiki",
      resolvedPath: "a/api/auth.md",
      documentSlug: "a-api-auth",
      inCorpus: true,
    });
    // …then fall through to other corpora…
    expect(byTarget.get("top")).toEqual({
      target: "top",
      kind: "wiki",
      resolvedPath: "top.md",
      documentSlug: "top",
      inCorpus: false,
    });
    // …and dangle with no resolved path when nothing matches.
    expect(byTarget.get("nowhere")).toEqual({
      target: "nowhere",
      kind: "wiki",
      resolvedPath: null,
      documentSlug: null,
      inCorpus: false,
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
    const o = await w.corpusOutline(K);
    const { byTarget } = linksOf(o, "a-guide-setup");
    expect(byTarget.get("../api/auth.md")).toEqual({
      target: "../api/auth.md",
      kind: "path",
      resolvedPath: "a/api/auth.md",
      documentSlug: "a-api-auth",
      inCorpus: true,
    });
  });

  it("moving a target document re-points resolution (bytes unchanged)", async () => {
    const w = ws();
    await build(w);
    // Move intro.md out of a/guide into folder `a` → path becomes a/intro.md.
    const moved = await w.moveDocument(
      docSlug("a-guide-intro"),
      { corpusSlug: K, folderSlug: await folderSlug(w, "a") },
      by,
    );
    expect(moved.ok).toBe(true);

    const o = await w.corpusOutline(K);
    const { byTarget } = linksOf(o, "a-guide-setup");
    // setup.md still says "./intro.md" verbatim, but that path is now
    // empty (intro lives at a/intro.md) → the link dangles.
    expect(byTarget.get("./intro.md")).toEqual({
      target: "./intro.md",
      kind: "path",
      resolvedPath: null,
      documentSlug: null,
      inCorpus: false,
    });
    // The moved document is still present at its new path.
    const movedDoc = o.found
      ? o.documents.find((d) => d.slug === "a-guide-intro")
      : undefined;
    expect(movedDoc?.path).toBe("a/intro.md");
  });

  it("an unknown corpus has no outline", async () => {
    const w = ws();
    expect(await w.corpusOutline(colSlug("nope"))).toEqual({
      found: false,
    });
  });
});
