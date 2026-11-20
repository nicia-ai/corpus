import { runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";

import { asCorpusSlug, asDocumentSlug, type DocumentSlug } from "../src/ids";
import type { CorpusStore } from "../src/store/handle";

import type { freshStore } from "./_helpers";

// Fixture: a project written in the pre-drive shape (one project-wide tree,
// corpora as selections over it), for the migration and the operator stats.

export const AUTHOR = "migration-test";
export const MARKER_KEY = "layout:corpus-drive:v1";
export const ALPHA = asCorpusSlug("alpha");
export const BETA = asCorpusSlug("beta");
export const SHARED = asDocumentSlug("shared");
export const GUIDE = asDocumentSlug("guide");
export const HANDBOOK_A = asDocumentSlug("handbook-a");
export const HANDBOOK_B = asDocumentSlug("handbook-b");
export const LOOSE = asDocumentSlug("loose");

export type Store = ReturnType<typeof freshStore>;

export type LegacyInstance = {
  ensureStore(): Promise<CorpusStore>;
  driveLayout: Promise<void> | undefined;
};

// The old project tree, as folder names → documents, and which corpus
// selected what.
const LEGACY_FOLDERS = [
  { slug: "docs", name: "docs", parent: null },
  { slug: "handbook", name: "handbook", parent: null },
  { slug: "handbook-sub", name: "sub", parent: "handbook" },
] as const;
const LEGACY_HOMES: Readonly<Record<DocumentSlug, string | null>> = {
  [SHARED]: "docs",
  [GUIDE]: "docs",
  [HANDBOOK_A]: "handbook",
  [HANDBOOK_B]: "handbook-sub",
  [LOOSE]: null,
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function save(
  store: Store,
  slug: DocumentSlug,
  markdown: string,
  clientVersion: number,
): Promise<void> {
  const r = await store.saveDocument({
    slug,
    markdown,
    clientVersion,
    changedBy: AUTHOR,
  });
  expect(r.ok, `saving ${slug}`).toBe(true);
}

// Write a project in the OLD shape. History comes from the public API (so
// versions are real); the tree is then torn down and rebuilt as the old
// project-wide tree by writing the graph directly, and the layout marker is
// cleared so the next read/write migrates.
//
//   alpha (older):  `shared` directly (`includes`)
//   beta  (newer):  folder `docs` (so `shared` AND `guide`) and folder
//                   `handbook` (so `handbook-a` and, nested, `handbook-b`)
//   `loose` is in no corpus.
export async function seedLegacyProject(store: Store): Promise<void> {
  await save(store, SHARED, "# Shared\nv1", 0);
  await save(store, SHARED, "# Shared\nv2", 1);
  await save(store, GUIDE, "# Guide", 0);
  await save(store, HANDBOOK_A, "# Handbook A", 0);
  await save(store, HANDBOOK_B, "# Handbook B", 0);
  await save(store, LOOSE, "# Loose", 0);
  await store.createCorpus({ slug: ALPHA, name: "Alpha", changedBy: AUTHOR });
  // Corpus creation time orders the two; keep them apart.
  await sleep(10);
  await store.createCorpus({ slug: BETA, name: "Beta", changedBy: AUTHOR });

  await runInDurableObject(store, async (instance, state) => {
    const inst = instance as unknown as LegacyInstance;
    const s = await inst.ensureStore();
    await s.transaction(async (tx) => {
      for (const edge of await tx.edges.in_folder.find({ limit: 1_000 })) {
        await tx.edges.in_folder.hardDelete(edge.id);
      }
      for (const edge of await tx.edges.includes_folder.find({
        limit: 1_000,
      })) {
        await tx.edges.includes_folder.hardDelete(edge.id);
      }
      for (const edge of await tx.edges.folder_child.find({ limit: 1_000 })) {
        await tx.edges.folder_child.hardDelete(edge.id);
      }
      for (const folder of await tx.nodes.Folder.find({ limit: 1_000 })) {
        await tx.nodes.Folder.hardDelete(folder.id);
      }

      const folders = new Map<string, { kind: "Folder"; id: string }>();
      for (const f of LEGACY_FOLDERS) {
        const node = await tx.nodes.Folder.create({
          slug: f.slug,
          name: f.name,
          createdAt: "2020-01-01T00:00:00.000Z",
        });
        folders.set(f.slug, { kind: "Folder", id: node.id });
      }
      for (const f of LEGACY_FOLDERS) {
        const child = folders.get(f.slug);
        const parent = f.parent === null ? undefined : folders.get(f.parent);
        if (child !== undefined && parent !== undefined) {
          await tx.edges.folder_child.create(parent, child, { position: 1 });
        }
      }
      const docRef = async (slug: string) => {
        const [node] = await tx.nodes.Document.find({
          where: (d) => d.slug.eq(slug),
          limit: 1,
        });
        if (node === undefined) throw new Error(`no document ${slug}`);
        return { kind: "Document" as const, id: node.id };
      };
      for (const [slug, home] of Object.entries(LEGACY_HOMES)) {
        const folder = home === null ? undefined : folders.get(home);
        if (folder !== undefined) {
          await tx.edges.in_folder.create(await docRef(slug), folder, {
            position: 1,
          });
        }
      }
      const corpusRef = async (slug: string) => {
        const [node] = await tx.nodes.Collection.find({
          where: (c) => c.slug.eq(slug),
          limit: 1,
        });
        if (node === undefined) throw new Error(`no corpus ${slug}`);
        return { kind: "Collection" as const, id: node.id };
      };
      await tx.edges.includes.create(
        await corpusRef(ALPHA),
        await docRef(SHARED),
        { position: 1, delivery: "core" },
      );
      const docsFolder = folders.get("docs");
      const handbookFolder = folders.get("handbook");
      if (docsFolder === undefined || handbookFolder === undefined) {
        throw new Error("legacy folders were not created");
      }
      await tx.edges.includes_folder.create(await corpusRef(BETA), docsFolder, {
        position: 1,
        delivery: "core",
      });
      await tx.edges.includes_folder.create(
        await corpusRef(BETA),
        handbookFolder,
        { position: 2, delivery: "reference" },
      );
    });
    await state.storage.delete(MARKER_KEY);
    inst.driveLayout = undefined;
  });
}
