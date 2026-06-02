import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { asFolderSlug } from "../src/ids";
import { type Bundle, canonicalJson } from "../src/store/domain/bundle";

import { colSlug, docSlug, freshStore } from "./_helpers";

const SOURCE = { organization: "acme", project: "default" };
const COLLECTION = colSlug("team");
const DOCS = [
  { slug: "a-alpha", path: "a/alpha.md", title: "Alpha" },
  { slug: "a-beta", path: "a/beta.md", title: "Beta" },
  { slug: "b-gamma", path: "b/gamma.md", title: "Gamma" },
] as const;

type DocSlugValue = (typeof DOCS)[number]["slug"];
type FolderName = "a" | "b";
type Op = Readonly<
  | {
      kind: "attach-doc";
      doc: DocSlugValue;
      position: number;
      delivery: "core" | "reference";
    }
  | {
      kind: "attach-folder";
      folder: FolderName;
      position: number;
      delivery: "core" | "reference";
    }
  | { kind: "detach-doc"; doc: DocSlugValue }
  | { kind: "archive-doc"; doc: DocSlugValue }
  | { kind: "rename-file"; doc: DocSlugValue; suffix: number }
  | { kind: "place-doc"; doc: DocSlugValue; folder: FolderName | "root" }
  | { kind: "reimport"; doc: (typeof DOCS)[number]; version: number }
  | { kind: "delete-folder"; folder: FolderName }
  | { kind: "reorder"; reverse: boolean }
>;

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant("attach-doc"),
    doc: fc.constantFrom(...DOCS.map((d) => d.slug)),
    position: fc.integer({ min: 1, max: 4 }),
    delivery: fc.constantFrom("core", "reference"),
  }),
  fc.record({
    kind: fc.constant("attach-folder"),
    folder: fc.constantFrom("a", "b"),
    position: fc.integer({ min: 1, max: 4 }),
    delivery: fc.constantFrom("core", "reference"),
  }),
  fc.record({
    kind: fc.constant("detach-doc"),
    doc: fc.constantFrom(...DOCS.map((d) => d.slug)),
  }),
  fc.record({
    kind: fc.constant("archive-doc"),
    doc: fc.constantFrom(...DOCS.map((d) => d.slug)),
  }),
  fc.record({
    kind: fc.constant("rename-file"),
    doc: fc.constantFrom(...DOCS.map((d) => d.slug)),
    suffix: fc.integer({ min: 1, max: 50 }),
  }),
  fc.record({
    kind: fc.constant("place-doc"),
    doc: fc.constantFrom(...DOCS.map((d) => d.slug)),
    folder: fc.constantFrom("a", "b", "root"),
  }),
  fc.record({
    kind: fc.constant("reimport"),
    doc: fc.constantFrom(...DOCS),
    version: fc.integer({ min: 1, max: 50 }),
  }),
  fc.record({
    kind: fc.constant("delete-folder"),
    folder: fc.constantFrom("a", "b"),
  }),
  fc.record({
    kind: fc.constant("reorder"),
    reverse: fc.boolean(),
  }),
);

function stable(bundle: Bundle): string {
  return canonicalJson({
    ...bundle,
    manifest: { ...bundle.manifest, exportedAt: "<normalized>" },
  });
}

async function folderSlug(
  store: ReturnType<typeof freshStore>,
  name: FolderName,
): Promise<ReturnType<typeof asFolderSlug> | undefined> {
  const folder = (await store.listFolders()).find((f) => f.name === name);
  return folder === undefined ? undefined : asFolderSlug(folder.slug);
}

async function seed(store: ReturnType<typeof freshStore>): Promise<void> {
  for (const d of DOCS) {
    await store.importDocumentAtPath({
      path: d.path,
      markdown: `# ${d.title}\ninitial`,
      changedBy: "prop",
    });
  }
  await store.createCollection({
    slug: COLLECTION,
    name: "Team",
    changedBy: "prop",
  });
}

async function applyOp(
  store: ReturnType<typeof freshStore>,
  op: Op,
): Promise<void> {
  switch (op.kind) {
    case "attach-doc":
      await store.attachDocument(
        COLLECTION,
        docSlug(op.doc),
        op.position,
        "prop",
        op.delivery,
      );
      return;
    case "attach-folder": {
      const slug = await folderSlug(store, op.folder);
      if (slug !== undefined) {
        await store.attachFolderToCollection(
          COLLECTION,
          slug,
          op.position,
          "prop",
          op.delivery,
        );
      }
      return;
    }
    case "detach-doc":
      await store.detachDocument(COLLECTION, docSlug(op.doc), "prop");
      return;
    case "archive-doc":
      await store.archiveDocument(docSlug(op.doc), "prop");
      return;
    case "rename-file":
      await store.renameFilename({
        slug: docSlug(op.doc),
        filename: `${op.doc}-${op.suffix.toString()}.md`,
        changedBy: "prop",
      });
      return;
    case "place-doc": {
      const folder =
        op.folder === "root" ? null : await folderSlug(store, op.folder);
      if (op.folder === "root" || folder !== undefined) {
        await store.placeDocumentInFolder(docSlug(op.doc), folder, "prop");
      }
      return;
    }
    case "reimport":
      await store.importDocumentAtPath({
        path: op.doc.path,
        markdown: `# ${op.doc.title}\nversion ${op.version.toString()}`,
        changedBy: "prop",
      });
      return;
    case "delete-folder": {
      const slug = await folderSlug(store, op.folder);
      if (slug !== undefined) await store.deleteFolder(slug, "prop");
      return;
    }
    case "reorder": {
      const order = DOCS.map((d) => docSlug(d.slug));
      await store.reorderCollectionDocuments(
        COLLECTION,
        op.reverse ? [...order].reverse() : order,
        "prop",
      );
      return;
    }
  }
}

describe("ProjectStore command invariants (property)", () => {
  it("preserves history, archive visibility, and bundle round-trip under bounded workflows", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(opArb, { minLength: 1, maxLength: 14 }),
        async (ops) => {
          const store = freshStore("prop-a");
          await seed(store);
          for (const op of ops) await applyOp(store, op);

          expect(await store.verifyHistory()).toEqual({ ok: true });

          const activeSlugs = new Set(
            (await store.listDocuments()).map((d) => d.slug),
          );
          const collection = await store.readCollection(COLLECTION);
          if (collection.found) {
            for (const d of collection.documents) {
              expect(activeSlugs.has(d.slug)).toBe(true);
              await expect(
                store.getDocument(docSlug(d.slug)),
              ).resolves.toBeDefined();
            }
          }

          const hasArchiveLikeOp = ops.some(
            (op) => op.kind === "archive-doc" || op.kind === "delete-folder",
          );
          if (!hasArchiveLikeOp) {
            const exported = await store.exportBundle(SOURCE);
            const imported = freshStore("prop-b");
            expect(await imported.importBundle(exported)).toMatchObject({
              ok: true,
            });
            expect(stable(await imported.exportBundle(SOURCE))).toBe(
              stable(exported),
            );
          }
        },
      ),
      { numRuns: 8, seed: 20260528 },
    );
  }, 120_000);
});
