import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { CollectionDelivery } from "../src/store/domain/collection-delivery";
import { DEFAULT_CORPUS_SLUG } from "../src/store/domain/default-corpus";
import {
  computeProjectStats,
  type StatsCorpus,
  type StatsDocument,
  type StatsFolder,
  type StatsLayout,
} from "../src/store/domain/project-stats";
import type { CorpusStore } from "../src/store/handle";

import { colSlug, docSlug, freshStore } from "./_helpers";
import { MARKER_KEY, seedLegacyProject } from "./_legacy-shape";

const NO_LAYOUT: StatsLayout = {
  corporaWithRoot: 0,
  documentsOutsideRoots: 0,
  legacyDirectLinks: 0,
  legacyFolderLinks: 0,
};

function doc(path: string, folderSlug: string | null): StatsDocument {
  const filename = path.split("/").at(-1) ?? path;
  return { slug: path.replace(/\W+/g, "-"), filename, path, folderSlug };
}

function member(d: StatsDocument, delivery: CollectionDelivery = "core") {
  return { slug: d.slug, delivery };
}

// Hand-built project:
//   folders: docs/ (top), docs/api/ (child), guides/ (top)
//   docs: a, b, f (docs tree), c, e (guides), d (root), g (in no corpus)
//   alpha: direct {a, c} + folder docs  -> resolved c(ref), a, b  (not lexical)
//   beta:  folder docs                   -> a, b, f               (lexical)
//   default: direct {d}                  -> d
//   gamma: direct {e}                    -> e
const a = doc("docs/a.md", "docs");
const b = doc("docs/api/b.md", "docs-api");
const f = doc("docs/shared.md", "docs");
const c = doc("guides/c.md", "guides");
const e = doc("guides/shared.md", "guides");
const d = doc("d.md", null);
const g = doc("g.md", null);

const folders: StatsFolder[] = [
  { slug: "docs", parentSlug: null },
  { slug: "docs-api", parentSlug: "docs" },
  { slug: "guides", parentSlug: null },
];

const corpora: StatsCorpus[] = [
  {
    slug: "alpha",
    directDocumentSlugs: [a.slug, c.slug],
    folderSlugs: ["docs"],
    members: [member(c, "reference"), member(a), member(b)],
  },
  {
    slug: "beta",
    directDocumentSlugs: [],
    folderSlugs: ["docs"],
    members: [member(a), member(b), member(f)],
  },
  {
    slug: "default",
    directDocumentSlugs: [d.slug],
    folderSlugs: [],
    members: [member(d)],
  },
  {
    slug: "gamma",
    directDocumentSlugs: [e.slug],
    folderSlugs: [],
    members: [member(e)],
  },
];

describe("computeProjectStats (pure)", () => {
  const stats = computeProjectStats({
    archivedDocuments: 2,
    liveDocuments: [a, b, c, d, e, f, g],
    corpora,
    folders,
    links: [
      { sourceSlug: a.slug, targetSlug: c.slug }, // share alpha
      { sourceSlug: a.slug, targetSlug: e.slug }, // alpha/beta vs gamma: cross
      { sourceSlug: d.slug, targetSlug: g.slug }, // g in no corpus
      { sourceSlug: a.slug, targetSlug: a.slug }, // self link ignored
    ],
    layout: NO_LAYOUT,
  });

  it("counts documents by resolved corpus membership", () => {
    expect(stats.documents).toEqual({
      total: 9,
      live: 7,
      archived: 2,
      inNoCorpus: 1, // g
      inOneCorpus: 4, // c, d, e, f
      inTwoOrMoreCorpora: 2, // a, b (alpha + beta)
    });
  });

  it("counts corpora, inclusion kinds, default, and member totals", () => {
    expect(stats.corpora).toEqual({
      total: 4,
      withDirectDocuments: 3,
      withFolderInclusions: 2,
      withBothInclusionKinds: 1,
      withDocumentViaBoth: 1, // alpha: a is direct AND under linked docs/
      defaultPresent: true,
      defaultMembers: 1,
      maxMembers: 3,
      totalMembers: 8,
    });
  });

  it("describes each corpus by index, never by name", () => {
    expect(stats.perCorpus).toEqual([
      {
        members: 3,
        distinctTopLevelFolders: 2,
        distinctParentFolders: 3,
        membersAtRoot: 0,
        coreMembers: 2,
        referenceMembers: 1,
        orderDiffersFromLexicalPath: true,
      },
      {
        members: 3,
        distinctTopLevelFolders: 1,
        distinctParentFolders: 2,
        membersAtRoot: 0,
        coreMembers: 3,
        referenceMembers: 0,
        orderDiffersFromLexicalPath: false,
      },
      {
        members: 1,
        distinctTopLevelFolders: 0,
        distinctParentFolders: 0,
        membersAtRoot: 1,
        coreMembers: 1,
        referenceMembers: 0,
        orderDiffersFromLexicalPath: false,
      },
      {
        members: 1,
        distinctTopLevelFolders: 1,
        distinctParentFolders: 1,
        membersAtRoot: 0,
        coreMembers: 1,
        referenceMembers: 0,
        orderDiffersFromLexicalPath: false,
      },
    ]);
  });

  it("measures folder geometry and multi-corpus folder inclusion", () => {
    expect(stats.folders).toEqual({
      total: 3,
      maxDepth: 2,
      topLevel: 2,
      includedByTwoOrMoreCorpora: 1, // docs: alpha + beta
    });
  });

  it("counts same-filename pairs that straddle corpora", () => {
    // docs/shared.md (beta) vs guides/shared.md (gamma)
    expect(stats.sameFilenamePairsAcrossCorpora).toBe(1);
  });

  it("counts resolved links and those sharing no corpus", () => {
    expect(stats.links).toEqual({ resolved: 3, crossCorpus: 1 });
  });

  it("never carries names, slugs, or paths", () => {
    const json = JSON.stringify(stats);
    for (const secret of ["alpha", "gamma", "docs", "guides", "shared"]) {
      expect(json).not.toContain(secret);
    }
  });

  it("is empty-safe", () => {
    const empty = computeProjectStats({
      archivedDocuments: 0,
      liveDocuments: [],
      corpora: [],
      folders: [],
      links: [],
      layout: NO_LAYOUT,
    });
    expect(empty.corpora.defaultPresent).toBe(false);
    expect(empty.folders.maxDepth).toBe(0);
    expect(empty.perCorpus).toEqual([]);
  });
});

describe("ProjectStore.statsSnapshot (DO)", () => {
  const BY = "u";
  const place = async (
    store: ReturnType<typeof freshStore>,
    corpus: string,
    path: string,
    markdown: string,
  ) => {
    const r = await store.importDocumentAtPath({
      corpusSlug: colSlug(corpus),
      path,
      markdown,
      changedBy: BY,
    });
    expect(r.ok, `importing ${path}`).toBe(true);
  };

  it("describes a project laid out as drives", async () => {
    const store = freshStore("stats");
    await store.ensureDefaultCorpus(BY);
    for (const slug of ["one", "two"]) {
      await store.createCorpus({
        slug: colSlug(slug),
        name: slug,
        changedBy: BY,
      });
    }
    await place(store, "one", "guides/alpha.md", "alpha");
    await place(store, "one", "beta.md", "see [alpha](guides/alpha.md)");
    // Same file name as `one`'s alpha, in another corpus; links across corpora.
    await place(store, "two", "alpha.md", "[beta](beta.md)");
    await place(store, DEFAULT_CORPUS_SLUG, "draft.md", "a draft");
    await place(store, "one", "gone.md", "archived");
    const gone = (await store.listDocuments()).find(
      (x) => x.path === "gone.md",
    );
    if (gone === undefined) throw new Error("gone.md missing");
    await store.archiveDocument(docSlug(gone.slug), BY);

    const stats = await store.statsSnapshot();

    expect(stats.documents).toEqual({
      total: 5,
      live: 4,
      archived: 1,
      inNoCorpus: 0,
      inOneCorpus: 4,
      inTwoOrMoreCorpora: 0,
    });
    expect(stats.corpora).toMatchObject({
      total: 3,
      defaultPresent: true,
      defaultMembers: 1,
      maxMembers: 2,
      totalMembers: 4,
      withDirectDocuments: 0,
      withFolderInclusions: 0,
    });
    // Roots are hidden: only the `guides` folder counts, and it is top-level.
    expect(stats.folders).toEqual({
      total: 1,
      maxDepth: 1,
      topLevel: 1,
      includedByTwoOrMoreCorpora: 0,
    });
    // Resolution is per corpus: `[beta](beta.md)` from corpus two falls
    // through to one's beta.md (a cross-corpus link); beta -> alpha stays in one.
    expect(stats.links).toEqual({ resolved: 2, crossCorpus: 1 });
    expect(stats.sameFilenamePairsAcrossCorpora).toBe(1);
    expect(stats.layout).toEqual({
      corporaWithRoot: 3,
      documentsOutsideRoots: 0,
      legacyDirectLinks: 0,
      legacyFolderLinks: 0,
    });
  });

  it("describes a project still in the pre-drive shape, and does not migrate it", async () => {
    const store = freshStore("stats-legacy");
    await seedLegacyProject(store);

    const stats = await store.statsSnapshot();

    expect(stats.documents).toMatchObject({
      live: 5,
      inNoCorpus: 1, // loose
      inOneCorpus: 3, // guide, handbook-a, handbook-b (beta only)
      inTwoOrMoreCorpora: 1, // shared: alpha directly, beta via `docs`
    });
    expect(stats.corpora).toMatchObject({
      withDirectDocuments: 1,
      withFolderInclusions: 1,
      withDocumentViaBoth: 0,
    });
    expect(stats.layout).toMatchObject({
      documentsOutsideRoots: 5,
      legacyDirectLinks: 1,
      legacyFolderLinks: 2,
    });
    // beta's second folder link was written `reference`.
    expect(stats.perCorpus.reduce((n, c) => n + c.referenceMembers, 0)).toBe(2);

    // The diagnostic is read-only: the layout marker is still unset, the old
    // links are still in the graph, and no folder was recreated.
    await runInDurableObject(store, async (instance, state) => {
      expect(await state.storage.get(MARKER_KEY)).toBeUndefined();
      const s = await (
        instance as unknown as {
          ensureStore(): Promise<CorpusStore>;
        }
      ).ensureStore();
      expect(await s.edges.includes.find({ limit: 100 })).toHaveLength(1);
      expect(await s.edges.includes_folder.find({ limit: 100 })).toHaveLength(
        2,
      );
      expect(await s.nodes.Folder.find({ limit: 100 })).toHaveLength(3);
    });
    // A second snapshot is identical, and an ordinary read afterwards still migrates.
    expect(await store.statsSnapshot()).toEqual(stats);
    await store.listDocuments();
    expect((await store.statsSnapshot()).layout).toMatchObject({
      documentsOutsideRoots: 0,
      legacyDirectLinks: 0,
      legacyFolderLinks: 0,
    });
  });
});
