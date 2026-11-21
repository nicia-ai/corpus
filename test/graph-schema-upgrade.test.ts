import { defineGraph } from "@nicia-ai/typegraph";
import { runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { createAdapterStoreWithSchema as createStorePrev } from "typegraph-prev";
import { createSqliteBackend as createBackendPrev } from "typegraph-prev/adapters/drizzle/sqlite";
import { describe, expect, it } from "vitest";

import { ledgerMigrations } from "../drizzle-do/migrations";
import {
  canonicalGraph,
  Collection,
  COLLECTION_BY_SLUG,
  CollectionVersion,
  COLLECTION_VERSION_BY_SLUG_VERSION,
  Document,
  DOCUMENT_BY_SLUG,
  DocumentVersion,
  DOCUMENT_VERSION_BY_SLUG_VERSION,
  Folder,
  FOLDER_BY_SLUG,
  folderChild,
  GRAPH_ID,
  inFolder,
  includes,
  includesFolder,
  versionOfCollection,
  versionsOf,
} from "../src/graph";
import { formatOfExtension } from "../src/store/domain/file-kinds";

import { colSlug, docSlug, freshStore } from "./_helpers";

// Every other test in this suite builds a graph from scratch, which takes
// `ensureSchema`'s `initializeSchema` path — there is no stored schema to
// diff against and no pre-existing physical storage to adopt. That is
// precisely why the 0.50 claim-relations bump shipped a boot failure for
// every EXISTING project while the whole suite passed (see AGENTS.md).
//
// This test provisions a project's DO-SQLite storage with the PREVIOUS
// TypeGraph release (`typegraph-prev`, an npm alias pinned one minor
// behind), then reopens that same storage through the real `ensureStore`,
// so a schema- or base-storage-affecting bump fails here instead of on
// every existing project's next boot.
//
// The graph document is the same object both releases see: it is plain
// data and its shape is a released contract. If a future release changes
// that shape, this seeding step is what tells us.
//
// On the next TypeGraph bump: repoint `typegraph-prev` at the release
// being upgraded FROM, so this always tests the hop that is shipping.
const SEEDED = "seeded-under-previous-release";

// TypeGraph's recorded-history relations. Projects first provisioned before
// 0.33 never had them. Base-schema release 3 (0.57) originally adopted by
// indexing them without CREATE TABLE; 0.66.1 creates the missing tables
// during v3 adoption. This case is the production failure from the
// 0.56 -> 0.65 bump: "no such table: typegraph_recorded_nodes".
const RECORDED_RELATIONS = [
  "typegraph_recorded_nodes",
  "typegraph_recorded_edges",
] as const;

// The ONE cross-version seam, isolated here so nothing else in the test
// carries it. `canonicalGraph` is plain data and both releases read the
// same fields, but the two installed copies brand `JsonPointer` with
// their own `unique symbol`, so the graph document is nominally — never
// structurally — foreign to the previous release's signature. If a
// future release changes the graph document's SHAPE rather than just its
// brand identities, this seeding call is what surfaces it: it will fail
// at runtime, not silently pass.
// The graph as every project provisioned before uploaded files existed has
// it: the same kinds and constraints, without `File` and `file_in_folder`. A
// real project stores exactly this schema, so booting the CURRENT graph over
// it is the hop that adds the File kind to an adopted store.
const unique = (name: string, fields: string[]) => [
  { name, fields, scope: "kind" as const, collation: "binary" as const },
];
const graphBeforeFiles = defineGraph({
  id: GRAPH_ID,
  nodes: {
    Document: { type: Document, unique: unique(DOCUMENT_BY_SLUG, ["slug"]) },
    DocumentVersion: {
      type: DocumentVersion,
      unique: unique(DOCUMENT_VERSION_BY_SLUG_VERSION, ["slug", "docVersion"]),
    },
    Collection: {
      type: Collection,
      unique: unique(COLLECTION_BY_SLUG, ["slug"]),
    },
    CollectionVersion: {
      type: CollectionVersion,
      unique: unique(COLLECTION_VERSION_BY_SLUG_VERSION, [
        "collectionSlug",
        "collectionVersion",
      ]),
    },
    Folder: { type: Folder, unique: unique(FOLDER_BY_SLUG, ["slug"]) },
  },
  edges: {
    includes: { type: includes, from: [Collection], to: [Document] },
    includes_folder: {
      type: includesFolder,
      from: [Collection],
      to: [Folder],
    },
    folder_child: { type: folderChild, from: [Folder], to: [Folder] },
    in_folder: { type: inFolder, from: [Document], to: [Folder] },
    versions_of: {
      type: versionsOf,
      from: [Document],
      to: [DocumentVersion],
    },
    version_of_collection: {
      type: versionOfCollection,
      from: [Collection],
      to: [CollectionVersion],
    },
  },
});

async function seedWithPreviousRelease(
  state: DurableObjectState,
  graph: unknown = canonicalGraph,
): Promise<void> {
  const [prev] = await createStorePrev(
    graph as Parameters<typeof createStorePrev>[0],
    createBackendPrev(drizzle(state.storage)),
  );
  await prev.materializeIndexes({ stopOnError: true });
  const documents = prev.nodes["Document"];
  if (documents === undefined) {
    throw new Error("the previous release did not register the Document kind");
  }
  // A real row, not just an empty schema: this exercises the unique claim
  // on `slug` and the `searchable()` fulltext projection, both of which
  // the 0.53 atomic-program rework moved into the write path.
  await documents.create({
    slug: SEEDED,
    title: "Seeded",
    filename: `${SEEDED}.md`,
    contentHash: "0".repeat(64),
    docVersion: 1,
    updatedAt: new Date().toISOString(),
    searchText: "Seeded legacy document",
  });
}

describe("upgrade path: a project provisioned by the previous release", () => {
  it("boots, adopts, and serves storage written by the previous release", async () => {
    const store = freshStore("upgrade");

    await runInDurableObject(store, async (_instance, state) => {
      await migrate(drizzle(state.storage), ledgerMigrations);
      await seedWithPreviousRelease(state);
    });

    // First contact with the current release. This is the boot that 0.50
    // turned into a 500 for every existing project.
    const docs = await store.listDocuments();
    expect(docs.map((d) => d.slug)).toContain(SEEDED);

    // And the current release can still WRITE against adopted storage —
    // claims, fulltext projection, and the optimistic-concurrency unique
    // all ride the save path.
    const saved = await store.saveDocument({
      slug: docSlug(SEEDED),
      markdown: "# Rewritten by the current release\n",
      clientVersion: 1,
      changedBy: "upgrade-test",
    });
    expect(saved).toEqual({ ok: true, docVersion: 2 });

    const fresh = await store.saveDocument({
      slug: docSlug("written-after-upgrade"),
      markdown: "# New\n",
      clientVersion: 0,
      changedBy: "upgrade-test",
    });
    expect(fresh).toEqual({ ok: true, docVersion: 1 });
  });

  // v1: a project no release-3 boot has touched yet. v2: one that already
  // failed the 0.56 -> 0.65 boot in production -- adoption stamps each step
  // before the next runs, so the failed open leaves it at v2, and 0.56 then
  // refuses it, which is why the fix has to roll forward.
  it.each([1, 2])(
    "boots a project at base-schema v%i whose storage predates the recorded-history relations",
    async (stampedVersion) => {
      const store = freshStore(`upgrade-legacy-v${String(stampedVersion)}`);

      await runInDurableObject(store, async (_instance, state) => {
        await migrate(drizzle(state.storage), ledgerMigrations);
        await seedWithPreviousRelease(state);
        for (const relation of RECORDED_RELATIONS) {
          state.storage.sql.exec(`DROP TABLE ${relation}`);
        }
        state.storage.sql.exec(
          "UPDATE typegraph_base_schema_versions SET version = ?",
          stampedVersion,
        );
      });

      const docs = await store.listDocuments();
      expect(docs.map((d) => d.slug)).toContain(SEEDED);

      await runInDurableObject(store, (_instance, state) => {
        const present = state.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)",
            ...RECORDED_RELATIONS,
          )
          .toArray()
          .map((row) => row.name);
        expect(new Set(present)).toEqual(new Set(RECORDED_RELATIONS));
      });
    },
  );

  // The File kind arrived after projects existed. Opening the current graph
  // over storage that has never heard of it must add the kind, its edge and
  // its indexes, keep every existing row, and then accept file writes: the
  // path `ensureStore` self-heals on every project's next boot.
  it("adds the File kind to a project provisioned before uploaded files existed", async () => {
    const store = freshStore("upgrade-files");
    await runInDurableObject(store, async (_instance, state) => {
      await migrate(drizzle(state.storage), ledgerMigrations);
      await seedWithPreviousRelease(state, graphBeforeFiles);
      const kinds = state.storage.sql
        .exec<{ n: number }>(
          "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'corpus_file_%'",
        )
        .one().n;
      expect(kinds).toBe(0);
    });

    const docs = await store.listDocuments();
    expect(docs.map((d) => d.slug)).toContain(SEEDED);

    const corpus = colSlug("after-upgrade");
    await store.createCorpus({
      slug: corpus,
      name: "After",
      changedBy: "upgrade-test",
    });
    const page = await store.importDocumentAtPath({
      corpusSlug: corpus,
      path: "guide/page.md",
      markdown: "![](./shot.png)",
      changedBy: "upgrade-test",
    });
    if (!page.ok) throw new Error("the page could not be created");
    const png = formatOfExtension("png");
    if (png === undefined) throw new Error("the png format must exist");
    const hash = "ab".repeat(32);
    const attached = await store.attachFile({
      documentSlug: docSlug(page.slug),
      name: "shot.png",
      contentHash: hash,
      size: 12,
      format: png,
      changedBy: "upgrade-test",
    });
    expect(attached).toMatchObject({ ok: true, created: true });
    expect((await store.fileByHash(hash))?.filename).toBe("shot.png");

    // The adopted schema now carries the File indexes TypeGraph materialized.
    await runInDurableObject(store, (_instance, state) => {
      const present = state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'corpus_file_%'",
        )
        .toArray()
        .map((row) => row.name);
      expect(new Set(present)).toEqual(
        new Set(["corpus_file_slug_idx", "corpus_file_hash_idx"]),
      );
    });
    // And the older rows are intact.
    expect((await store.listDocuments()).map((d) => d.slug)).toContain(SEEDED);
  });
});
