import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  asCorpusSlug,
  asDocumentSlug,
  asFolderSlug,
  type CorpusSlug,
} from "../src/ids";
import {
  buildCorpusPathIndex,
  comparePaths,
  corpusIsServed,
  corpusRelativePath,
  planDriveLayout,
  resolveCorpusLink,
} from "../src/store/domain/corpus-drive";
import { DEFAULT_CORPUS_SLUG } from "../src/store/domain/default-corpus";
import type { CorpusStore } from "../src/store/handle";

import { freshStore } from "./_helpers";

const AUTHOR = "drive-test";
const ALPHA = asCorpusSlug("alpha");
const BETA = asCorpusSlug("beta");
const README = asDocumentSlug("readme-alpha");
const README_BETA = asDocumentSlug("readme-beta");

type Store = ReturnType<typeof freshStore>;

async function create(
  store: Store,
  slug: string,
  markdown: string,
  corpusSlug: CorpusSlug,
  folderSlug: string | null = null,
): Promise<void> {
  const r = await store.saveDocument({
    slug: asDocumentSlug(slug),
    markdown,
    filename: `${slug}.md`,
    location: {
      corpusSlug,
      folderSlug: folderSlug === null ? null : asFolderSlug(folderSlug),
    },
    clientVersion: 0,
    changedBy: AUTHOR,
  });
  expect(r, `creating ${slug}`).toEqual({ ok: true, docVersion: 1 });
}

// The structural invariant of the drive model, read straight from the
// graph: no corpus holds a direct document link, each has exactly one
// folder link (to its root), every root is top-level, and every live
// document sits under a root. Run after the operations that used to leak.
async function expectDriveShape(store: Store): Promise<void> {
  await store.listDocuments();
  await runInDurableObject(store, async (instance) => {
    const s = await (
      instance as unknown as { ensureStore(): Promise<CorpusStore> }
    ).ensureStore();
    const corpora = await s.nodes.Collection.find({ limit: 1_000 });
    expect(await s.edges.includes.find({ limit: 1_000 })).toHaveLength(0);
    const links = await s.edges.includes_folder.find({ limit: 1_000 });
    expect(links).toHaveLength(corpora.length);
    expect(new Set(links.map((l) => l.fromId)).size).toBe(corpora.length);
    const rootIds = new Set(links.map((l) => l.toId));
    const topLevel = new Set(
      (await s.nodes.Folder.find({ limit: 1_000 })).map((f) => f.id),
    );
    for (const edge of await s.edges.folder_child.find({ limit: 1_000 })) {
      topLevel.delete(edge.toId);
    }
    expect([...topLevel].sort()).toEqual([...rootIds].sort());
  });
  const located = await store.listDocuments();
  const members = new Set<string>();
  for (const corpus of await store.listCorpora()) {
    for (const slug of (await store.corpusMembers(asCorpusSlug(corpus.slug))) ??
      []) {
      expect(members.has(slug), `${slug} is in exactly one corpus`).toBe(false);
      members.add(slug);
    }
  }
  expect([...members].sort()).toEqual(located.map((d) => d.slug).sort());
}

describe("corpus structure", () => {
  it("creating a corpus creates its hidden root; the root never appears in a path", async () => {
    const store = freshStore("drive-structure");
    await store.createCorpus({ slug: ALPHA, name: "Alpha", changedBy: AUTHOR });
    await create(store, "intro", "# Intro", ALPHA);

    expect(await store.listFolders()).toEqual([]);
    const [doc] = await store.listDocuments();
    expect(doc).toMatchObject({
      corpusSlug: ALPHA,
      path: "intro.md",
      folderSlug: null,
    });
    await expectDriveShape(store);
  });

  it("renaming a corpus changes no corpus-relative path", async () => {
    const store = freshStore("drive-rename");
    await store.createCorpus({ slug: ALPHA, name: "Alpha", changedBy: AUTHOR });
    const made = await store.createFolder("policies", {
      corpusSlug: ALPHA,
      folderSlug: null,
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    await create(store, "refunds", "# Refunds", ALPHA, made.slug);
    const before = (await store.listDocuments()).map((d) => d.path);

    expect(
      await store.updateCorpus({
        slug: ALPHA,
        name: "Renamed",
        description: "new",
        changedBy: AUTHOR,
      }),
    ).toEqual({ ok: true });

    expect((await store.listDocuments()).map((d) => d.path)).toEqual(before);
    expect(before).toEqual(["policies/refunds.md"]);
    await expectDriveShape(store);
  });

  it("refuses to place a document or folder in a corpus or folder that is not there", async () => {
    const store = freshStore("drive-unknown");
    await store.createCorpus({ slug: ALPHA, name: "Alpha", changedBy: AUTHOR });
    await store.createCorpus({ slug: BETA, name: "Beta", changedBy: AUTHOR });
    const betaFolder = await store.createFolder("only-beta", {
      corpusSlug: BETA,
      folderSlug: null,
    });
    if (!betaFolder.ok) throw new Error("setup");

    const missingCorpus = await store.saveDocument({
      slug: asDocumentSlug("ghost"),
      markdown: "# Ghost",
      location: { corpusSlug: asCorpusSlug("nope"), folderSlug: null },
      clientVersion: 0,
      changedBy: AUTHOR,
    });
    expect(missingCorpus).toEqual({ ok: false, unknownLocation: true });

    // A folder of ANOTHER corpus is not a place in this one.
    const wrongCorpus = await store.saveDocument({
      slug: asDocumentSlug("stray"),
      markdown: "# Stray",
      location: {
        corpusSlug: ALPHA,
        folderSlug: asFolderSlug(betaFolder.slug),
      },
      clientVersion: 0,
      changedBy: AUTHOR,
    });
    expect(wrongCorpus).toEqual({ ok: false, unknownLocation: true });
    expect(
      await store.createFolder("x", {
        corpusSlug: ALPHA,
        folderSlug: asFolderSlug(betaFolder.slug),
      }),
    ).toEqual({ ok: false, reason: "missing" });
    expect(await store.listDocuments()).toEqual([]);
  });

  it("a new document with no corpus named lands in the default corpus, and an upload keeps its tree under one root", async () => {
    const store = freshStore("drive-default");
    await store.saveDocument({
      slug: asDocumentSlug("note"),
      markdown: "# Note",
      clientVersion: 0,
      changedBy: AUTHOR,
    });
    const upload = await store.importIntoCorpus({
      entries: [
        { path: "a/b/deep.md", markdown: "# Deep" },
        { path: "top.md", markdown: "# Top" },
      ],
      destination: { mode: "new", name: "Imported" },
      changedBy: AUTHOR,
    });
    expect(upload?.summary).toMatchObject({ created: 2, updated: 0 });

    const byPath = new Map(
      (await store.listDocuments()).map((d) => [d.path, d.corpusSlug]),
    );
    expect(byPath.get("note.md")).toBe(DEFAULT_CORPUS_SLUG);
    expect(byPath.get("a/b/deep.md")).toBe(upload?.corpusSlug);
    expect(byPath.get("top.md")).toBe(upload?.corpusSlug);
    await expectDriveShape(store);
  });
});

describe("the default corpus is the drafts space", () => {
  it("is not served; a page is served exactly when it is in a named corpus", async () => {
    const store = freshStore("drive-served");
    await store.createCorpus({ slug: ALPHA, name: "Alpha", changedBy: AUTHOR });
    await create(store, "draft", "# Draft", DEFAULT_CORPUS_SLUG);
    await create(store, "live", "# Live", ALPHA);

    expect(corpusIsServed(DEFAULT_CORPUS_SLUG)).toBe(false);
    expect(corpusIsServed(ALPHA)).toBe(true);
    expect(await store.isDocumentServed(asDocumentSlug("draft"))).toBe(false);
    expect(await store.isDocumentServed(asDocumentSlug("live"))).toBe(true);
  });

  it("moving a page into a named corpus publishes it; moving it back unpublishes it", async () => {
    const store = freshStore("drive-publish");
    await store.createCorpus({ slug: ALPHA, name: "Alpha", changedBy: AUTHOR });
    await create(store, "page", "# Page", DEFAULT_CORPUS_SLUG);
    const page = asDocumentSlug("page");

    expect(
      await store.moveDocument(
        page,
        { corpusSlug: ALPHA, folderSlug: null },
        AUTHOR,
      ),
    ).toEqual({ ok: true, changed: true });
    expect(await store.isDocumentServed(page)).toBe(true);
    expect(await store.corpusMembers(ALPHA)).toEqual(["page"]);

    expect(
      await store.moveDocument(
        page,
        { corpusSlug: DEFAULT_CORPUS_SLUG, folderSlug: null },
        AUTHOR,
      ),
    ).toEqual({ ok: true, changed: true });
    expect(await store.isDocumentServed(page)).toBe(false);
    expect(await store.corpusMembers(ALPHA)).toEqual([]);
  });

  it("a share link's direct-edit right is decided at write time, against where the page is now", async () => {
    const store = freshStore("drive-embassy");
    await store.createCorpus({ slug: ALPHA, name: "Alpha", changedBy: AUTHOR });
    await create(store, "shared-page", "# Shared\nv1", DEFAULT_CORPUS_SLUG);
    const slug = asDocumentSlug("shared-page");
    const draft = (clientVersion: number) =>
      store.saveSharedDraft({
        slug,
        markdown: `# Shared\nv${String(clientVersion + 1)}`,
        clientVersion,
        changedBy: "embassy:link",
      });

    expect(await draft(1)).toEqual({ ok: true, docVersion: 2 });

    await store.moveDocument(
      slug,
      { corpusSlug: ALPHA, folderSlug: null },
      AUTHOR,
    );
    expect(await draft(2)).toEqual({ ok: false, served: true });

    await store.moveDocument(
      slug,
      { corpusSlug: DEFAULT_CORPUS_SLUG, folderSlug: null },
      AUTHOR,
    );
    expect(await draft(2)).toEqual({ ok: true, docVersion: 3 });
  });
});

describe("moving between corpora", () => {
  it("is an ordinary tree move: history travels, nothing is copied, both sides record it", async () => {
    const store = freshStore("drive-move");
    await store.createCorpus({ slug: ALPHA, name: "Alpha", changedBy: AUTHOR });
    await store.createCorpus({ slug: BETA, name: "Beta", changedBy: AUTHOR });
    const folder = await store.createFolder("docs", {
      corpusSlug: ALPHA,
      folderSlug: null,
    });
    if (!folder.ok) throw new Error("setup");
    await create(store, "guide", "# Guide v1", ALPHA, folder.slug);
    await store.saveDocument({
      slug: asDocumentSlug("guide"),
      markdown: "# Guide v2",
      clientVersion: 1,
      changedBy: AUTHOR,
    });
    const guide = asDocumentSlug("guide");
    const historyBefore = await store.documentHistory(guide);

    const moved = await store.moveFolder(
      asFolderSlug(folder.slug),
      { corpusSlug: BETA, folderSlug: null },
      AUTHOR,
    );
    expect(moved).toMatchObject({ ok: true });

    expect(await store.documentLocation(guide)).toMatchObject({
      corpusSlug: BETA,
      path: "docs/guide.md",
    });
    expect(await store.corpusMembers(ALPHA)).toEqual([]);
    expect(await store.documentHistory(guide)).toEqual(historyBefore);
    expect(
      (await store.listDocuments()).filter((d) => d.slug === "guide"),
    ).toHaveLength(1);

    const events = (await store.recentChanges(50)).filter(
      (c) => c.documentSlug === "guide",
    );
    expect(
      events
        .filter((c) => c.eventType.startsWith("collection."))
        .map((c) => [c.eventType, c.corpusSlug])
        .sort(),
    ).toEqual(
      [
        ["collection.attached", BETA],
        ["collection.detached", ALPHA],
      ].sort(),
    );
    await expectDriveShape(store);
  });

  it("bulk move reports a name clash in the destination instead of overwriting", async () => {
    const store = freshStore("drive-move-clash");
    await store.createCorpus({ slug: ALPHA, name: "Alpha", changedBy: AUTHOR });
    await store.createCorpus({ slug: BETA, name: "Beta", changedBy: AUTHOR });
    await create(store, "same", "# In alpha", ALPHA);
    const clash = await store.saveDocument({
      slug: asDocumentSlug("other"),
      markdown: "# In beta",
      filename: "same.md",
      location: { corpusSlug: BETA, folderSlug: null },
      clientVersion: 0,
      changedBy: AUTHOR,
    });
    expect(clash.ok).toBe(true);

    const result = await store.moveDocuments(
      [asDocumentSlug("same")],
      { corpusSlug: BETA, folderSlug: null },
      AUTHOR,
    );
    expect(result).toEqual({ moved: 0, failed: 1 });
    expect(await store.corpusMembers(ALPHA)).toEqual(["same"]);
  });
});

describe("deleting a corpus", () => {
  async function seedTwo(name: string): Promise<Store> {
    const store = freshStore(name);
    await store.createCorpus({ slug: ALPHA, name: "Alpha", changedBy: AUTHOR });
    const folder = await store.createFolder("docs", {
      corpusSlug: ALPHA,
      folderSlug: null,
    });
    if (!folder.ok) throw new Error("setup");
    await create(store, "one", "# One", ALPHA, folder.slug);
    await create(store, "two", "# Two", ALPHA);
    return store;
  }

  it("can delete its pages too: they are archived, not erased", async () => {
    const store = await seedTwo("drive-delete-archive");
    const historyBefore = await store.documentHistory(asDocumentSlug("one"));

    const result = await store.deleteCorpus({
      slug: ALPHA,
      pages: "archive",
      changedBy: AUTHOR,
    });

    expect(result).toMatchObject({ ok: true, moved: 0 });
    if (result.ok)
      expect([...result.archivedSlugs].sort()).toEqual(["one", "two"]);
    expect((await store.listCorpora()).map((c) => c.slug)).not.toContain(ALPHA);
    expect(await store.listDocuments()).toEqual([]);
    expect(await store.documentHistory(asDocumentSlug("one"))).toEqual(
      historyBefore,
    );
    await expectDriveShape(store);
  });

  it("can move its pages to the default corpus, unpublished and collision-free", async () => {
    const store = await seedTwo("drive-delete-move");
    await store.createCorpus({ slug: BETA, name: "Beta", changedBy: AUTHOR });
    await create(store, "two-in-beta", "# Beta two", BETA);
    // `two` and a draft share a filename with what the move brings in.
    await store.saveDocument({
      slug: asDocumentSlug("draft-two"),
      markdown: "# Draft two",
      filename: "two.md",
      clientVersion: 0,
      changedBy: AUTHOR,
    });

    const result = await store.deleteCorpus({
      slug: ALPHA,
      pages: "move-to-default",
      changedBy: AUTHOR,
    });

    expect(result).toMatchObject({ ok: true, moved: 2 });
    const located = new Map(
      (await store.listDocuments()).map((d) => [d.slug, d] as const),
    );
    expect(located.get("one")?.corpusSlug).toBe(DEFAULT_CORPUS_SLUG);
    expect(located.get("two")?.corpusSlug).toBe(DEFAULT_CORPUS_SLUG);
    expect(located.get("draft-two")?.path).toBe("two.md");
    expect(located.get("two")?.path).toBe("Alpha/two.md");
    expect(located.get("one")?.path).toBe("Alpha/docs/one.md");
    expect(await store.isDocumentServed(asDocumentSlug("one"))).toBe(false);
    await expectDriveShape(store);
  });

  it("cannot delete the default corpus, and a missing corpus is reported", async () => {
    const store = await seedTwo("drive-delete-default");
    expect(
      await store.deleteCorpus({
        slug: DEFAULT_CORPUS_SLUG,
        pages: "archive",
        changedBy: AUTHOR,
      }),
    ).toEqual({ ok: false, reason: "default-corpus" });
    expect(
      await store.deleteCorpus({
        slug: asCorpusSlug("never-existed"),
        pages: "archive",
        changedBy: AUTHOR,
      }),
    ).toEqual({ ok: false, reason: "missing" });
  });
});

describe("ordering and links across corpora", () => {
  it("lists a corpus lexically by corpus-relative path", async () => {
    const store = freshStore("drive-order");
    await store.createCorpus({ slug: ALPHA, name: "Alpha", changedBy: AUTHOR });
    for (const [slug, path] of [
      ["z-last", "z.md"],
      ["b-first", "b/one.md"],
      ["a-root", "a.md"],
    ] as const) {
      const r = await store.importDocumentAtPath({
        corpusSlug: ALPHA,
        path,
        markdown: `# ${slug}`,
        changedBy: AUTHOR,
      });
      expect(r.ok).toBe(true);
    }
    const outline = await store.corpusOutline(ALPHA);
    expect(outline.found && outline.documents.map((d) => d.path)).toEqual([
      "a.md",
      "b/one.md",
      "z.md",
    ]);
    expect((await store.listDocuments()).map((d) => d.path)).toEqual([
      "a.md",
      "b/one.md",
      "z.md",
    ]);
  });

  it("two corpora may each hold README.md: a link resolves in its own corpus first, and a link across corpora is flagged outside the corpus", async () => {
    const store = freshStore("drive-readme");
    await store.createCorpus({ slug: ALPHA, name: "Alpha", changedBy: AUTHOR });
    await store.createCorpus({ slug: BETA, name: "Beta", changedBy: AUTHOR });
    await store.saveDocument({
      slug: README,
      markdown:
        "# Alpha\nSee [guide](guide.md), [[README]] and [theirs](only-beta.md).",
      filename: "README.md",
      location: { corpusSlug: ALPHA, folderSlug: null },
      clientVersion: 0,
      changedBy: AUTHOR,
    });
    await store.saveDocument({
      slug: README_BETA,
      markdown: "# Beta\nSee [[README]].",
      filename: "README.md",
      location: { corpusSlug: BETA, folderSlug: null },
      clientVersion: 0,
      changedBy: AUTHOR,
    });
    await create(store, "guide", "# Guide", ALPHA);
    await store.saveDocument({
      slug: asDocumentSlug("only-beta"),
      markdown: "# Only beta",
      filename: "only-beta.md",
      location: { corpusSlug: BETA, folderSlug: null },
      clientVersion: 0,
      changedBy: AUTHOR,
    });

    const alpha = await store.corpusOutline(ALPHA);
    const beta = await store.corpusOutline(BETA);
    if (!alpha.found || !beta.found) throw new Error("outline");
    const alphaReadme = alpha.documents.find((d) => d.slug === README);
    const betaReadme = beta.documents.find((d) => d.slug === README_BETA);

    const wiki = (links: typeof alphaReadme) =>
      links?.links.find((l) => l.kind === "wiki");
    expect(wiki(alphaReadme)).toMatchObject({
      documentSlug: README,
      inCorpus: true,
    });
    expect(wiki(betaReadme)).toMatchObject({
      documentSlug: README_BETA,
      inCorpus: true,
    });
    expect(
      alphaReadme?.links.find((l) => l.target === "guide.md"),
    ).toMatchObject({ documentSlug: "guide", inCorpus: true });
    expect(
      alphaReadme?.links.find((l) => l.target === "only-beta.md"),
    ).toMatchObject({ documentSlug: "only-beta", inCorpus: false });
  });
});

describe("corpus-drive domain rules (pure)", () => {
  it("resolves a link in the source's own corpus before any other", () => {
    const index = buildCorpusPathIndex([
      { slug: "a-readme", path: "README.md", corpusSlug: "a" },
      { slug: "b-readme", path: "README.md", corpusSlug: "b" },
      { slug: "b-extra", path: "extra.md", corpusSlug: "b" },
    ]);
    const source = { corpusSlug: "b", path: "notes/x.md" };
    expect(
      resolveCorpusLink(source, { kind: "wiki", target: "README" }, index),
    ).toEqual({ corpusSlug: "b", path: "README.md", documentSlug: "b-readme" });
    expect(
      resolveCorpusLink(
        { corpusSlug: "a", path: "README.md" },
        { kind: "path", target: "extra.md" },
        index,
      ),
    ).toEqual({ corpusSlug: "b", path: "extra.md", documentSlug: "b-extra" });
    expect(
      resolveCorpusLink(
        source,
        { kind: "path", target: "../../nope.md" },
        index,
      ),
    ).toBeUndefined();
  });

  it("derives a corpus-relative path by dropping the root, and orders by code unit", () => {
    expect(corpusRelativePath(["root", "docs", "api"], "a.md")).toBe(
      "docs/api/a.md",
    );
    expect(corpusRelativePath(["root"], "a.md")).toBe("a.md");
    expect(["b", "B", "a"].sort(comparePaths)).toEqual(["B", "a", "b"]);
  });

  it("plans the layout: a shared page goes where it is needed, loose pages go to drafts, a page already under a root stays", () => {
    const corpora = [
      { slug: "late", createdAt: "2024-02-01T00:00:00.000Z" },
      { slug: "early", createdAt: "2024-01-01T00:00:00.000Z" },
    ];
    const both = {
      slug: "both",
      folderNames: ["x"],
      homeCorpusSlug: undefined,
      memberOf: ["late", "early"],
    };
    const none = {
      slug: "none",
      folderNames: [],
      homeCorpusSlug: undefined,
      memberOf: [],
    };
    const settled = {
      slug: "settled",
      folderNames: ["early-root"],
      homeCorpusSlug: "early",
      memberOf: ["early"],
    };
    // `early` already holds a page, `late` would be empty: `both` goes to late.
    const needy = planDriveLayout({
      corpora,
      defaultCorpusSlug: "default",
      documents: [both, none, settled],
    });
    expect(needy.placements).toEqual([
      { documentSlug: "both", corpusSlug: "late", folderNames: ["x"] },
      { documentSlug: "none", corpusSlug: "default", folderNames: [] },
    ]);
    expect(needy.conflicts).toEqual([
      { documentSlug: "both", keptIn: "late", droppedFrom: ["early"] },
    ]);
    // Both corpora hold pages already: the earliest-created wins.
    const settledLate = {
      ...settled,
      slug: "settled-late",
      homeCorpusSlug: "late",
    };
    const plain = planDriveLayout({
      corpora,
      defaultCorpusSlug: "default",
      documents: [both, settled, settledLate],
    });
    expect(plain.placements).toEqual([
      { documentSlug: "both", corpusSlug: "early", folderNames: ["x"] },
    ]);
  });

  it("settles shared pages over the whole project: two shared pages cannot both leave the one corpus that needed either", () => {
    const corpora = [
      { slug: "a", createdAt: "2024-01-01T00:00:00.000Z" },
      { slug: "b", createdAt: "2024-01-02T00:00:00.000Z" },
    ];
    const doc = (slug: string) => ({
      slug,
      folderNames: [],
      homeCorpusSlug: undefined,
      memberOf: ["a", "b"],
    });
    const plan = planDriveLayout({
      corpora,
      defaultCorpusSlug: "default",
      documents: [doc("s1"), doc("s2")],
    });
    expect(plan.placements.map((p) => p.corpusSlug).sort()).toEqual(["a", "b"]);
  });
});
