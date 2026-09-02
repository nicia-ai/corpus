import { runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { createAdapterStoreWithSchema as createStorePrev } from "typegraph-prev";
import { createSqliteBackend as createBackendPrev } from "typegraph-prev/adapters/drizzle/sqlite";
import { describe, expect, it } from "vitest";

import { ledgerMigrations } from "../drizzle-do/migrations";
import { canonicalGraph } from "../src/graph";

import { docSlug, freshStore } from "./_helpers";

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

// The ONE cross-version seam, isolated here so nothing else in the test
// carries it. `canonicalGraph` is plain data and both releases read the
// same fields, but the two installed copies brand `JsonPointer` with
// their own `unique symbol`, so the graph document is nominally — never
// structurally — foreign to the previous release's signature. If a
// future release changes the graph document's SHAPE rather than just its
// brand identities, this seeding call is what surfaces it: it will fail
// at runtime, not silently pass.
async function seedWithPreviousRelease(
  state: DurableObjectState,
): Promise<void> {
  const [prev] = await createStorePrev(
    canonicalGraph as unknown as Parameters<typeof createStorePrev>[0],
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
});
