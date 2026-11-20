import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { CorpusSlug } from "../src/ids";
import { MEMBERSHIP_REASON_LAYOUT } from "../src/store/domain/change-events";
import { corpusRootFolderSlug } from "../src/store/domain/corpus-drive";
import { DEFAULT_CORPUS_SLUG } from "../src/store/domain/default-corpus";

import { freshStore } from "./_helpers";
import {
  ALPHA,
  BETA,
  GUIDE,
  HANDBOOK_A,
  HANDBOOK_B,
  LOOSE,
  type LegacyInstance,
  MARKER_KEY,
  seedLegacyProject,
  SHARED,
  type Store,
} from "./_legacy-shape";

// Keeper for the one-time move of a project written before corpora were
// drives (one project-wide tree; corpora = selections over it) into the
// drive layout: each corpus owns a root folder, every document sits under
// the root of exactly one corpus, at its existing project path.

async function pathsOf(
  store: Store,
  corpusSlug: CorpusSlug,
): Promise<readonly string[]> {
  const outline = await store.corpusOutline(corpusSlug);
  expect(outline.found).toBe(true);
  return outline.found ? outline.documents.map((d) => d.path) : [];
}

describe("drive layout migration", () => {
  it("lays a project written in the old shape out as drives", async () => {
    const store = freshStore("drive-migration");
    await seedLegacyProject(store);
    const historyBefore = await store.documentHistory(SHARED);
    expect(historyBefore).toHaveLength(2);

    // The first read triggers the migration.
    const located = new Map(
      (await store.listDocuments()).map((d) => [d.slug, d] as const),
    );

    // `shared` was resolved by BOTH corpora: it stays in the earliest-created
    // one, at its existing project path.
    expect(located.get(SHARED)).toMatchObject({
      corpusSlug: ALPHA,
      path: "docs/shared.md",
    });
    // `guide` was only in beta (via the `docs` folder): it keeps its path.
    expect(located.get(GUIDE)).toMatchObject({
      corpusSlug: BETA,
      path: "docs/guide.md",
    });
    // A folder-included set keeps its nested shape under beta's root.
    expect(located.get(HANDBOOK_A)).toMatchObject({
      corpusSlug: BETA,
      path: "handbook/handbook-a.md",
    });
    expect(located.get(HANDBOOK_B)).toMatchObject({
      corpusSlug: BETA,
      path: "handbook/sub/handbook-b.md",
    });
    // A document in no corpus lands in the default (drafts) corpus.
    expect(located.get(LOOSE)).toMatchObject({
      corpusSlug: DEFAULT_CORPUS_SLUG,
      path: "loose.md",
    });

    // Membership is exactly "under the root", ordered by path.
    expect(await pathsOf(store, ALPHA)).toEqual(["docs/shared.md"]);
    expect(await pathsOf(store, BETA)).toEqual([
      "docs/guide.md",
      "handbook/handbook-a.md",
      "handbook/sub/handbook-b.md",
    ]);
    expect(await pathsOf(store, DEFAULT_CORPUS_SLUG)).toEqual(["loose.md"]);

    // The folders are recreated under each root (the old top-level folders
    // are gone), so a folder is listed once per corpus that needed it, and
    // none is top-level except through a root.
    const folders = await store.listFolders();
    expect(
      folders
        .map((f) => [f.corpusSlug, f.name, f.parentSlug === null] as const)
        .sort(),
    ).toEqual(
      [
        [ALPHA, "docs", true],
        [BETA, "docs", true],
        [BETA, "handbook", true],
        [BETA, "sub", false],
      ].sort(),
    );
    for (const corpusSlug of [ALPHA, BETA, DEFAULT_CORPUS_SLUG]) {
      expect(await store.corpusMembers(corpusSlug)).toBeDefined();
    }
    const exported = await store.exportBundle({
      organization: "acme",
      project: "default",
    });
    const rootFolders = exported.manifest.folders.filter((f) =>
      f.slug.startsWith("corpus-root:"),
    );
    expect(rootFolders.map((f) => f.slug).sort()).toEqual(
      [ALPHA, BETA, DEFAULT_CORPUS_SLUG].map(corpusRootFolderSlug).sort(),
    );

    // History survives untouched.
    expect(await store.documentHistory(SHARED)).toEqual(historyBefore);
    expect((await store.verifyHistory()).ok).toBe(true);
  });

  it("records the document resolved into two corpora in the activity log", async () => {
    const store = freshStore("drive-migration-log");
    await seedLegacyProject(store);
    await store.listDocuments();

    const changes = await store.recentChanges(200);
    const dropped = changes.filter(
      (c) => c.eventType === "collection.detached" && c.documentSlug === SHARED,
    );
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.corpusSlug).toBe(BETA);
    expect(JSON.parse(dropped[0]?.afterJson ?? "{}")).toEqual({
      reason: MEMBERSHIP_REASON_LAYOUT,
      movedTo: ALPHA,
    });
  });

  it("is a no-op the second time", async () => {
    const store = freshStore("drive-migration-idempotent");
    await seedLegacyProject(store);
    const first = await store.listDocuments();
    const lastEvent = await store.lastEventId();

    // Force a second pass: clear the marker and the in-DO cache, as a
    // crash between commit and marker would.
    await runInDurableObject(store, async (instance, state) => {
      (instance as unknown as LegacyInstance).driveLayout = undefined;
      await state.storage.delete(MARKER_KEY);
    });

    expect(await store.listDocuments()).toEqual(first);
    expect(await store.lastEventId()).toBe(lastEvent);
    expect(await store.corpusMembers(BETA)).toHaveLength(3);
  });

  it("leaves an empty project and a new project alone", async () => {
    const store = freshStore("drive-migration-fresh");
    expect(await store.listDocuments()).toEqual([]);
    expect(await store.listFolders()).toEqual([]);
    expect(await store.lastEventId()).toBe(0);
  });
});
