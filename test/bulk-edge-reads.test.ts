import { describe, expect, it } from "vitest";

import { asFolderSlug } from "../src/ids";
import type { ProjectStore } from "../src/project-store";
import { setGraphStatementSinkForTest } from "../src/store/statement-log";

import { colSlug, docSlug, freshStore } from "./_helpers";

// The set-oriented reads (`bulkFindFrom` / `bulkFindTo` / `getByIds`) are
// invisible in results — a `findFrom` per node returns exactly the same
// data, just one statement at a time. So the regression these tests keep
// is the COST: run the identical operation over a small and a large
// fixture and require the statements it submits to match. An absolute
// count would break on any unrelated TypeGraph change; invariance across
// N is the property that actually matters and only breaks when someone
// reintroduces a per-item read.
//
// `setGraphStatementSinkForTest` is module-level (like the paging seam), so
// it observes the statements issued INSIDE the DO.
const SMALL = 3;
const LARGE = 12;

// A widened endpoint predicate — `to_id IN (?, ?, …)` — is what a bulk
// read compiles to, and what a loop of point reads never produces.
const WIDENED_ENDPOINT = '_id" IN (';

type Store = DurableObjectStub<ProjectStore>;

async function measure<T>(
  fn: () => Promise<T>,
): Promise<Readonly<{ result: T; statements: readonly string[] }>> {
  const statements: string[] = [];
  const restore = setGraphStatementSinkForTest((sql) => statements.push(sql));
  try {
    return { result: await fn(), statements };
  } finally {
    restore();
  }
}

// A statement's shape: whitespace collapsed, and the bind list of an
// `IN (…)` collapsed too, so the SAME set read over 3 and over 12 rows
// compares equal. Sorted, because independent reads inside one operation
// are dispatched concurrently and their order is not a guarantee.
function shapes(statements: readonly string[]): string[] {
  return statements
    .map((sql) =>
      sql
        .replace(/\s+/gu, " ")
        .replace(/IN \(\?(?:, \?)*\)/gu, "IN (…)")
        .trim(),
    )
    .sort();
}

// Both fixtures run the same operation; only their size differs, so the
// statement multiset must be identical. Comparing shapes rather than a
// count makes the failure self-describing: the diff names the statement
// that came back once per item.
function expectSameCost(few: readonly string[], many: readonly string[]): void {
  expect(shapes(many)).toEqual(shapes(few));
}

describe("set-oriented graph reads (statement count is independent of N)", () => {
  async function withCollectionMembers(
    count: number,
  ): Promise<
    Readonly<{ store: Store; slugs: readonly ReturnType<typeof docSlug>[] }>
  > {
    const store = freshStore("bulk-members");
    const slugs = Array.from({ length: count }, (_, i) =>
      docSlug(`m-${String(i)}`),
    );
    await store.createCollection({
      slug: colSlug("team"),
      name: "Team",
      changedBy: "u",
    });
    for (const [i, slug] of slugs.entries()) {
      await store.saveDocument({
        slug,
        markdown: `# Member ${String(i)}\nbody`,
        clientVersion: 0,
        changedBy: "u",
      });
      await store.attachDocument(colSlug("team"), slug, i + 1, "u");
    }
    await store.readCollection(colSlug("team"));
    return { store, slugs };
  }

  async function withChildFolders(count: number): Promise<Store> {
    const store = freshStore("bulk-folders");
    const root = await store.createFolder("root", null);
    if (!root.ok) throw new Error("fixture: root folder was not created");
    for (let i = 0; i < count; i += 1) {
      const child = await store.createFolder(
        `child-${String(i)}`,
        asFolderSlug(root.slug),
      );
      if (!child.ok) throw new Error(`fixture: child ${String(i)}`);
    }
    // Init (schema reconcile, index materialization) must not land inside
    // the measured window.
    await store.listFolders();
    return store;
  }

  it("reads every folder's parent edge in one widened statement", async () => {
    const [few, many] = await Promise.all([
      withChildFolders(SMALL),
      withChildFolders(LARGE),
    ]);
    const forFew = await measure(() => few.listFolders());
    const forMany = await measure(() => many.listFolders());

    expect(forFew.result).toHaveLength(SMALL + 1);
    expect(forMany.result).toHaveLength(LARGE + 1);
    expectSameCost(forFew.statements, forMany.statements);
    expect(
      forMany.statements.filter((sql) => sql.includes(WIDENED_ENDPOINT)),
    ).toHaveLength(1);
  });

  it("scans the root's documents in one read when placing a document there", async () => {
    async function withRootDocuments(count: number): Promise<Store> {
      const store = freshStore("bulk-root-docs");
      for (let i = 0; i < count; i += 1) {
        await store.saveDocument({
          slug: docSlug(`root-${String(i)}`),
          markdown: `# Root ${String(i)}`,
          clientVersion: 0,
          changedBy: "u",
        });
      }
      // The document that moves back to the root under measurement — the
      // sibling-namespace check there reads every root document.
      const shelf = await store.createFolder("shelf", null);
      if (!shelf.ok) throw new Error("fixture: shelf folder");
      await store.saveDocument({
        slug: docSlug("mover"),
        markdown: "# Mover",
        clientVersion: 0,
        changedBy: "u",
      });
      const placed = await store.placeDocumentInFolder(
        docSlug("mover"),
        asFolderSlug(shelf.slug),
        "u",
      );
      if (!placed.ok) throw new Error("fixture: place into shelf");
      return store;
    }

    const [few, many] = await Promise.all([
      withRootDocuments(SMALL),
      withRootDocuments(LARGE),
    ]);
    // The async wrapper normalizes the DO stub's generated union thenables to
    // one Promise result type for `measure`.
    const move = (store: Store) =>
      measure(
        async () =>
          await store.placeDocumentInFolder(docSlug("mover"), null, "u"),
      );
    const forFew = await move(few);
    const forMany = await move(many);

    // Equal counts are only meaningful if the move actually happened.
    expect(forFew.result).toEqual({ ok: true, changed: true });
    expect(forMany.result).toEqual({ ok: true, changed: true });
    expectSameCost(forFew.statements, forMany.statements);
  });

  it("checks every collection's folder links in one read on a folder rename", async () => {
    async function withCollections(count: number): Promise<
      Readonly<{
        store: Store;
        folderSlug: ReturnType<typeof asFolderSlug>;
      }>
    > {
      const store = freshStore("bulk-cols");
      const folder = await store.createFolder("docs", null);
      if (!folder.ok) throw new Error("fixture: folder");
      for (let i = 0; i < count; i += 1) {
        await store.createCollection({
          slug: colSlug(`c-${String(i)}`),
          name: `C ${String(i)}`,
          changedBy: "u",
        });
      }
      return { store, folderSlug: asFolderSlug(folder.slug) };
    }

    const [few, many] = await Promise.all([
      withCollections(SMALL),
      withCollections(LARGE),
    ]);
    const forFew = await measure(
      async () => await few.store.renameFolder(few.folderSlug, "renamed", "u"),
    );
    const forMany = await measure(
      async () =>
        await many.store.renameFolder(many.folderSlug, "renamed", "u"),
    );

    expect(forFew.result).toEqual({ ok: true, changed: true });
    expect(forMany.result).toEqual({ ok: true, changed: true });
    expectSameCost(forFew.statements, forMany.statements);
  });

  it("hydrates a named folder's child folders and documents in set reads", async () => {
    async function withSiblings(count: number): Promise<
      Readonly<{
        store: Store;
        target: ReturnType<typeof asFolderSlug>;
      }>
    > {
      const store = freshStore("bulk-siblings");
      const parent = await store.createFolder("parent", null);
      if (!parent.ok) throw new Error("fixture: parent folder");
      const parentSlug = asFolderSlug(parent.slug);
      const target = await store.createFolder("target", parentSlug);
      if (!target.ok) throw new Error("fixture: target folder");
      for (let i = 0; i < count; i += 1) {
        const sibling = await store.createFolder(
          `sibling-${String(i)}`,
          parentSlug,
        );
        if (!sibling.ok) throw new Error(`fixture: sibling ${String(i)}`);
        const slug = docSlug(`nested-${String(i)}`);
        await store.saveDocument({
          slug,
          markdown: `# Nested ${String(i)}`,
          clientVersion: 0,
          changedBy: "u",
        });
        const placed = await store.placeDocumentInFolder(slug, parentSlug, "u");
        if (!placed.ok) throw new Error(`fixture: nested doc ${String(i)}`);
      }
      return { store, target: asFolderSlug(target.slug) };
    }

    const [few, many] = await Promise.all([
      withSiblings(SMALL),
      withSiblings(LARGE),
    ]);
    const forFew = await measure(
      async () => await few.store.renameFolder(few.target, "renamed", "u"),
    );
    const forMany = await measure(
      async () => await many.store.renameFolder(many.target, "renamed", "u"),
    );

    expect(forFew.result).toEqual({ ok: true, changed: true });
    expect(forMany.result).toEqual({ ok: true, changed: true });
    expectSameCost(forFew.statements, forMany.statements);
  });

  it("hydrates a collection's members in one read, not one per member", async () => {
    const [few, many] = await Promise.all([
      withCollectionMembers(SMALL),
      withCollectionMembers(LARGE),
    ]);
    const forFew = await measure(
      async () => await few.store.readCollection(colSlug("team")),
    );
    const forMany = await measure(
      async () => await many.store.readCollection(colSlug("team")),
    );

    expect(forFew.result.found).toBe(true);
    expect(forMany.result.found).toBe(true);
    if (forMany.result.found) {
      expect(forMany.result.documents).toHaveLength(LARGE);
    }
    expectSameCost(forFew.statements, forMany.statements);
  });

  it("hydrates collection members once when reordering", async () => {
    const [few, many] = await Promise.all([
      withCollectionMembers(SMALL),
      withCollectionMembers(LARGE),
    ]);
    const reorder = (
      fixture: Awaited<ReturnType<typeof withCollectionMembers>>,
    ) => {
      const [first, second, ...rest] = fixture.slugs;
      if (first === undefined || second === undefined) {
        throw new Error("fixture: at least two collection members");
      }
      return measure(
        async () =>
          await fixture.store.reorderCollectionDocuments(
            colSlug("team"),
            [second, first, ...rest],
            "u",
          ),
      );
    };
    const forFew = await reorder(few);
    const forMany = await reorder(many);

    expect(forFew.result).toEqual({ ok: true });
    expect(forMany.result).toEqual({ ok: true });
    expectSameCost(forFew.statements, forMany.statements);
  });
});
