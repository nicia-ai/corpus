import { describe, expect, it } from "vitest";

import { asFolderSlug, type DocumentSlug } from "../src/ids";
import type { ProjectStore } from "../src/project-store";
import { setGraphStatementSinkForTest } from "../src/store/statement-log";

import { colSlug, docSlug, freshStore } from "./_helpers";

const TEAM = colSlug("team");
const INBOX = colSlug("inbox");

// The set-oriented reads (`query` traversals, `bulkFindFrom` /
// `bulkFindTo`, `getByIds`) are invisible in results — a `findFrom` per
// node returns exactly the same data, just one statement at a time. So
// the regression these tests keep is the COST: run the identical
// operation over a small and a large fixture and require the statements
// it submits to match. An absolute count would break on any unrelated
// TypeGraph change; invariance across N is the property that actually
// matters and only breaks when someone reintroduces a per-item read.
//
// `setGraphStatementSinkForTest` is module-level (like the paging seam), so
// it observes the statements issued INSIDE the DO.
const SMALL = 3;
const LARGE = 12;

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

// A statement's shape: whitespace collapsed, and the N-dependent parts of a
// set read collapsed too, so the SAME set read over 3 and over 12 rows
// compares equal: the bind list of an `IN (…)`, and the per-key arms of the
// probe query (`CASE WHEN … THEN i` and the `OR` chain of key matches), which
// grow with the key count inside one statement. Sorted, because independent
// reads inside one operation are dispatched concurrently and their order is
// not a guarantee.
function shapes(statements: readonly string[]): string[] {
  return statements
    .map((sql) =>
      sql
        .replace(/\s+/gu, " ")
        .replace(/IN \(\?(?:, \?)*\)/gu, "IN (…)")
        .replace(/(?:WHEN \(.+? IS \?\) THEN \d+ )+/gu, "WHEN … ")
        .replace(/(?: OR \(\(json_extract\(.+?\) IS \?\)\))+/gu, " OR …")
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

// The statements that are set reads: SELECTs, minus the by-id edge lookup
// `hardDelete` issues once per deleted edge.
const HARDDELETE_EDGE_LOOKUP = /FROM "typegraph_edges" WHERE .*"id" = \?$/u;
function reads(statements: readonly string[]): readonly string[] {
  return statements.filter(
    (sql) => sql.startsWith("SELECT") && !HARDDELETE_EDGE_LOOKUP.test(sql),
  );
}

describe("set-oriented graph reads (statement count is independent of N)", () => {
  async function withCorpusMembers(
    count: number,
  ): Promise<Readonly<{ store: Store; slugs: readonly DocumentSlug[] }>> {
    const store = freshStore("bulk-members");
    const slugs = Array.from({ length: count }, (_, i) =>
      docSlug(`m-${String(i)}`),
    );
    await store.createCorpus({ slug: TEAM, name: "Team", changedBy: "u" });
    for (const [i, slug] of slugs.entries()) {
      await store.saveDocument({
        slug,
        markdown: `# Member ${String(i)}\nbody`,
        location: { corpusSlug: TEAM, folderSlug: null },
        clientVersion: 0,
        changedBy: "u",
      });
    }
    await store.corpusOutline(TEAM);
    return { store, slugs };
  }

  async function withChildFolders(count: number): Promise<Store> {
    const store = freshStore("bulk-folders");
    await store.createCorpus({ slug: TEAM, name: "Team", changedBy: "u" });
    const root = await store.createFolder("root", {
      corpusSlug: TEAM,
      folderSlug: null,
    });
    if (!root.ok) throw new Error("fixture: root folder was not created");
    for (let i = 0; i < count; i += 1) {
      const child = await store.createFolder(`child-${String(i)}`, {
        corpusSlug: TEAM,
        folderSlug: asFolderSlug(root.slug),
      });
      if (!child.ok) throw new Error(`fixture: child ${String(i)}`);
    }
    // Init (schema reconcile, index materialization) must not land inside
    // the measured window.
    await store.listFolders();
    return store;
  }

  it("reads every folder's parent in a statement count independent of N", async () => {
    const [few, many] = await Promise.all([
      withChildFolders(SMALL),
      withChildFolders(LARGE),
    ]);
    const forFew = await measure(() => few.listFolders());
    const forMany = await measure(() => many.listFolders());

    expect(forFew.result).toHaveLength(SMALL + 1);
    expect(forMany.result).toHaveLength(LARGE + 1);
    expectSameCost(forFew.statements, forMany.statements);
  });

  it("scans the corpus root's documents in one read when a document moves there", async () => {
    async function withRootDocuments(count: number): Promise<Store> {
      const store = freshStore("bulk-root-docs");
      await store.createCorpus({ slug: TEAM, name: "Team", changedBy: "u" });
      for (let i = 0; i < count; i += 1) {
        await store.saveDocument({
          slug: docSlug(`root-${String(i)}`),
          markdown: `# Root ${String(i)}`,
          location: { corpusSlug: TEAM, folderSlug: null },
          clientVersion: 0,
          changedBy: "u",
        });
      }
      // The document that moves back to the root under measurement — the
      // sibling-namespace check there reads every root document.
      const shelf = await store.createFolder("shelf", {
        corpusSlug: TEAM,
        folderSlug: null,
      });
      if (!shelf.ok) throw new Error("fixture: shelf folder");
      await store.saveDocument({
        slug: docSlug("mover"),
        markdown: "# Mover",
        location: { corpusSlug: TEAM, folderSlug: asFolderSlug(shelf.slug) },
        clientVersion: 0,
        changedBy: "u",
      });
      return store;
    }

    const [few, many] = await Promise.all([
      withRootDocuments(SMALL),
      withRootDocuments(LARGE),
    ]);
    // The async wrapper normalizes the DO stub's generated union thenables to
    // one Promise result type for `measure`.
    const moveToRoot = (store: Store) =>
      measure(
        async () =>
          await store.moveDocument(
            docSlug("mover"),
            { corpusSlug: TEAM, folderSlug: null },
            "u",
          ),
      );
    const forFew = await moveToRoot(few);
    const forMany = await moveToRoot(many);

    // Equal counts are only meaningful if the move actually happened.
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
      await store.createCorpus({ slug: TEAM, name: "Team", changedBy: "u" });
      const parent = await store.createFolder("parent", {
        corpusSlug: TEAM,
        folderSlug: null,
      });
      if (!parent.ok) throw new Error("fixture: parent folder");
      const parentLocation = {
        corpusSlug: TEAM,
        folderSlug: asFolderSlug(parent.slug),
      };
      const target = await store.createFolder("target", parentLocation);
      if (!target.ok) throw new Error("fixture: target folder");
      for (let i = 0; i < count; i += 1) {
        const sibling = await store.createFolder(
          `sibling-${String(i)}`,
          parentLocation,
        );
        if (!sibling.ok) throw new Error(`fixture: sibling ${String(i)}`);
        await store.saveDocument({
          slug: docSlug(`nested-${String(i)}`),
          markdown: `# Nested ${String(i)}`,
          location: parentLocation,
          clientVersion: 0,
          changedBy: "u",
        });
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

  it("hydrates a corpus's members in one read, not one per member", async () => {
    const [few, many] = await Promise.all([
      withCorpusMembers(SMALL),
      withCorpusMembers(LARGE),
    ]);
    const forFew = await measure(
      async () => await few.store.corpusOutline(TEAM),
    );
    const forMany = await measure(
      async () => await many.store.corpusOutline(TEAM),
    );

    expect(forFew.result.found).toBe(true);
    expect(forMany.result.found).toBe(true);
    if (forMany.result.found) {
      expect(forMany.result.documents).toHaveLength(LARGE);
    }
    expectSameCost(forFew.statements, forMany.statements);
  });

  it("hydrates the source corpus once when a batch of documents moves out", async () => {
    async function withInbox(
      count: number,
    ): Promise<Readonly<{ store: Store; slugs: readonly DocumentSlug[] }>> {
      const store = freshStore("bulk-move");
      await store.createCorpus({ slug: TEAM, name: "Team", changedBy: "u" });
      await store.createCorpus({ slug: INBOX, name: "Inbox", changedBy: "u" });
      const slugs = Array.from({ length: count }, (_, i) =>
        docSlug(`inbox-${String(i)}`),
      );
      for (const [i, slug] of slugs.entries()) {
        await store.saveDocument({
          slug,
          markdown: `# Inbox ${String(i)}`,
          location: { corpusSlug: INBOX, folderSlug: null },
          clientVersion: 0,
          changedBy: "u",
        });
      }
      await store.listDocuments();
      return { store, slugs };
    }

    const [few, many] = await Promise.all([withInbox(SMALL), withInbox(LARGE)]);
    const moveBatch = (fixture: Awaited<ReturnType<typeof withInbox>>) =>
      measure(
        async () =>
          await fixture.store.moveDocuments(
            fixture.slugs,
            { corpusSlug: TEAM, folderSlug: null },
            "u",
          ),
      );
    const forFew = await moveBatch(few);
    const forMany = await moveBatch(many);

    expect(forFew.result).toEqual({ moved: SMALL, failed: 0 });
    expect(forMany.result).toEqual({ moved: LARGE, failed: 0 });
    // Moving an edge is a per-document write (a hard delete and an insert,
    // plus the lookup `hardDelete` makes by edge id) and legitimately costs
    // a few statements per document — AGENTS.md: per-node hardDelete is
    // correct. What must not grow is every READ that decides the move.
    expectSameCost(reads(forFew.statements), reads(forMany.statements));
  });
});
