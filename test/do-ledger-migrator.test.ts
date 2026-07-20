import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { ledgerMigrations } from "../drizzle-do/migrations";

import { colSlug, docSlug, freshStore } from "./_helpers";

// The DO SQLite ledger schema (content_blobs, change_events) is no
// longer hand-written DDL — drizzle-kit owns it (src/db.ts →
// `pnpm db:generate:do` → drizzle-do/) and the Drizzle DO migrator
// applies it at ProjectStore init. These tests pin two things:
//   1. the generated bundle is well-formed and still covers both tables
//      (fails loudly if `db:generate:do` drifts or the codegen breaks);
//   2. migrate() running in Drizzle's own DO transaction *before*
//      TypeGraph init does NOT collide with TypeGraph's enlisted-tx DDL
//      ban (#135) — a fresh store's full save → verify → read path works.
const project = () => freshStore("ledger-mig");

describe("DO ledger Drizzle migrator", () => {
  it("the generated bundle is well-formed and covers both ledger tables", () => {
    expect(ledgerMigrations.journal.entries.length).toBeGreaterThanOrEqual(1);
    const first = ledgerMigrations.journal.entries[0];
    expect(first?.idx).toBe(0);
    // Key format the durable-sqlite migrator looks up
    // (`m${idx padStart 4}`); a mismatch means "Missing migration".
    const sql = ledgerMigrations.migrations.m0000;
    expect(sql).toBeDefined();
    expect(sql).toContain("CREATE TABLE `content_blobs`");
    expect(sql).toContain("CREATE TABLE `change_events`");
    // The migrator splits statements on this marker; its presence proves
    // both CREATEs are run, not just the first.
    expect(sql).toContain("--> statement-breakpoint");
  });

  it("a fresh ProjectStore inits via the migrator; save path + verify work", async () => {
    const store = project();

    // Hits content_blobs (blob dedup) + the DocumentVersion chain +
    // change_events (the save path appends a created event). If the
    // migrator hadn't run, this throws "no such table".
    await store.saveDocument({
      slug: docSlug("alpha"),
      markdown: "# Alpha\nv1",
      clientVersion: 0,
      changedBy: "u",
    });
    await store.saveDocument({
      slug: docSlug("alpha"),
      markdown: "# Alpha\nv2",
      clientVersion: 1,
      changedBy: "u",
    });
    await store.createCollection({
      slug: colSlug("c"),
      name: "C",
      changedBy: "u",
    });
    await store.attachDocument(colSlug("c"), docSlug("alpha"), 2, "u");

    const snap = await store.getDocument(docSlug("alpha"));
    expect(snap?.docVersion).toBe(2);

    // change_events is readable and was written by the save path.
    const changes = await store.recentChanges(10);
    expect(changes.length).toBeGreaterThan(0);

    // TypeGraph init ran fine after migrate() (no #135 collision) and
    // the whole chain re-derives intact.
    expect(await store.verifyHistory()).toEqual({ ok: true });
  });

  // Corpus used to hand-rebuild the two edge traversal indexes via a
  // marker-guarded physical migration, because TypeGraph's bootstrap could
  // not replace a same-name index that had a different column list. Since
  // 0.37 those are TypeGraph *system-index declarations* that its own
  // bootstrap materializes, so the hand-rolled migration is gone. This pins
  // the column lists we depend on: TypeGraph matches existing indexes by
  // NAME ONLY and never compares columns, so a silent upstream change to
  // either list would not self-heal — it has to fail here instead.
  it("TypeGraph bootstrap materializes the traversal and Corpus lookup indexes", async () => {
    const store = project();
    await store.listDocuments();

    await runInDurableObject(store, (_instance, state) => {
      const columns = (indexName: string): readonly string[] =>
        [
          ...state.storage.sql.exec<{ name: string }>(
            `PRAGMA index_info(${indexName})`,
          ),
        ].map((row) => row.name);

      expect(columns("typegraph_edges_from_idx")).toEqual([
        "graph_id",
        "from_kind",
        "from_id",
        "kind",
        "to_kind",
        "deleted_at",
        "valid_from",
        "valid_to",
        "to_id",
      ]);
      expect(columns("typegraph_edges_to_idx")).toEqual([
        "graph_id",
        "to_kind",
        "to_id",
        "kind",
        "from_kind",
        "deleted_at",
        "valid_from",
        "valid_to",
        "from_id",
      ]);
      expect(columns("corpus_document_slug_idx")).not.toHaveLength(0);
      expect(columns("corpus_document_version_idx")).not.toHaveLength(0);
      expect(columns("corpus_collection_slug_idx")).not.toHaveLength(0);
      expect(columns("corpus_collection_version_idx")).not.toHaveLength(0);
      expect(columns("corpus_folder_slug_idx")).not.toHaveLength(0);
    });
  });
});
