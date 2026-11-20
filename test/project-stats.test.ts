import { describe, expect, it } from "vitest";

import { asFolderSlug, asDocumentSlug, type DocumentSlug } from "../src/ids";
import type { CollectionDelivery } from "../src/store/domain/collection-expand";
import {
  computeProjectStats,
  type StatsCorpus,
  type StatsDocument,
  type StatsFolder,
} from "../src/store/domain/project-stats";

import { colSlug, freshStore } from "./_helpers";

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
    });
    expect(empty.corpora.defaultPresent).toBe(false);
    expect(empty.folders.maxDepth).toBe(0);
    expect(empty.perCorpus).toEqual([]);
  });
});

describe("ProjectStore.statsSnapshot (DO)", () => {
  it("returns the right counts for a seeded project", async () => {
    const store = freshStore("stats");
    const by = "u";
    await store.importDocumentAtPath({
      path: "guides/alpha.md",
      markdown: "alpha",
      changedBy: by,
    });
    await store.importDocumentAtPath({
      path: "beta.md",
      markdown: "see [alpha](guides/alpha.md)",
      changedBy: by,
    });
    await store.importDocumentAtPath({
      path: "orphan.md",
      markdown: "nobody includes me",
      changedBy: by,
    });
    await store.importDocumentAtPath({
      path: "solo.md",
      markdown: "[beta](beta.md)",
      changedBy: by,
    });
    await store.importDocumentAtPath({
      path: "gone.md",
      markdown: "archived",
      changedBy: by,
    });
    const slugOf = async (path: string): Promise<DocumentSlug> => {
      const row = (await store.listDocuments()).find((x) => x.path === path);
      if (row === undefined) throw new Error(`no document at ${path}`);
      return asDocumentSlug(row.slug);
    };
    await store.archiveDocument(await slugOf("gone.md"), by);

    const guides = (await store.listFolders()).find((x) => x.name === "guides");
    if (guides === undefined) throw new Error("guides folder missing");
    for (const slug of ["one", "two", "three"]) {
      await store.createCorpus({
        slug: colSlug(slug),
        name: slug,
        changedBy: by,
      });
    }
    // one: alpha directly AND via its folder; two: beta + alpha; three: solo.
    await store.attachDocument(
      colSlug("one"),
      await slugOf("guides/alpha.md"),
      1,
      by,
    );
    await store.attachFolderToCorpus(
      colSlug("one"),
      asFolderSlug(guides.slug),
      2,
      by,
    );
    await store.attachDocument(colSlug("two"), await slugOf("beta.md"), 1, by);
    await store.attachDocument(
      colSlug("two"),
      await slugOf("guides/alpha.md"),
      2,
      by,
    );
    await store.attachDocument(
      colSlug("three"),
      await slugOf("solo.md"),
      1,
      by,
    );

    const stats = await store.statsSnapshot();

    expect(stats.documents).toEqual({
      total: 5,
      live: 4,
      archived: 1,
      inNoCorpus: 1, // orphan
      inOneCorpus: 2, // beta, solo
      inTwoOrMoreCorpora: 1, // alpha
    });
    expect(stats.corpora).toMatchObject({
      total: 3,
      withDirectDocuments: 3,
      withFolderInclusions: 1,
      withBothInclusionKinds: 1,
      withDocumentViaBoth: 1,
      defaultPresent: false,
      maxMembers: 2,
      totalMembers: 4,
    });
    expect(stats.folders).toEqual({
      total: 1,
      maxDepth: 1,
      topLevel: 1,
      includedByTwoOrMoreCorpora: 0,
    });
    // beta -> alpha share "two"; solo -> beta share nothing.
    expect(stats.links).toEqual({ resolved: 2, crossCorpus: 1 });
    expect(stats.perCorpus).toHaveLength(3);
  });
});
