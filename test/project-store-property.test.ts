import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { asFolderSlug, type CorpusSlug } from "../src/ids";
import { type Bundle, canonicalJson } from "../src/store/domain/bundle";

import { colSlug, docSlug, freshStore } from "./_helpers";

const SOURCE = { organization: "acme", project: "default" };
const CORPORA = {
  team: colSlug("team"),
  other: colSlug("other"),
} as const;
const DOCS = [
  { slug: "a-alpha", path: "a/alpha.md", title: "Alpha" },
  { slug: "a-beta", path: "a/beta.md", title: "Beta" },
  { slug: "b-gamma", path: "b/gamma.md", title: "Gamma" },
] as const;

type DocSlugValue = (typeof DOCS)[number]["slug"];
type FolderName = "a" | "b";
type CorpusName = keyof typeof CORPORA;
type Op = Readonly<
  | {
      kind: "move-doc";
      doc: DocSlugValue;
      corpus: CorpusName;
      folder: FolderName | "root";
    }
  | { kind: "archive-doc"; doc: DocSlugValue }
  | { kind: "rename-file"; doc: DocSlugValue; suffix: number }
  | { kind: "reimport"; doc: (typeof DOCS)[number]; version: number }
  | { kind: "delete-folder"; folder: FolderName }
>;

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant("move-doc"),
    doc: fc.constantFrom(...DOCS.map((d) => d.slug)),
    corpus: fc.constantFrom<CorpusName>("team", "other"),
    folder: fc.constantFrom<FolderName | "root">("a", "b", "root"),
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
    kind: fc.constant("reimport"),
    doc: fc.constantFrom(...DOCS),
    version: fc.integer({ min: 1, max: 50 }),
  }),
  fc.record({
    kind: fc.constant("delete-folder"),
    folder: fc.constantFrom("a", "b"),
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
  corpusSlug: CorpusSlug,
  name: FolderName,
): Promise<ReturnType<typeof asFolderSlug> | undefined> {
  const folder = (await store.listFolders()).find(
    (f) => f.name === name && f.corpusSlug === corpusSlug,
  );
  return folder === undefined ? undefined : asFolderSlug(folder.slug);
}

// Every document lives in the team corpus, in the folder its path names.
async function seed(store: ReturnType<typeof freshStore>): Promise<void> {
  await store.createCorpus({
    slug: CORPORA.team,
    name: "Team",
    changedBy: "prop",
  });
  await store.createCorpus({
    slug: CORPORA.other,
    name: "Other",
    changedBy: "prop",
  });
  for (const d of DOCS) {
    await store.importDocumentAtPath({
      corpusSlug: CORPORA.team,
      path: d.path,
      markdown: `# ${d.title}\ninitial`,
      changedBy: "prop",
    });
  }
}

async function applyOp(
  store: ReturnType<typeof freshStore>,
  op: Op,
): Promise<void> {
  switch (op.kind) {
    case "move-doc": {
      const corpusSlug = CORPORA[op.corpus];
      const targetFolder =
        op.folder === "root"
          ? null
          : await folderSlug(store, corpusSlug, op.folder);
      if (targetFolder !== undefined) {
        await store.moveDocument(
          docSlug(op.doc),
          { corpusSlug, folderSlug: targetFolder },
          "prop",
        );
      }
      return;
    }
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
    case "reimport":
      await store.importDocumentAtPath({
        corpusSlug: CORPORA.team,
        path: op.doc.path,
        markdown: `# ${op.doc.title}\nversion ${op.version.toString()}`,
        changedBy: "prop",
      });
      return;
    case "delete-folder": {
      const slug = await folderSlug(store, CORPORA.team, op.folder);
      if (slug !== undefined) await store.deleteFolder(slug, "prop");
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
          for (const corpusSlug of Object.values(CORPORA)) {
            const outline = await store.corpusOutline(corpusSlug);
            if (!outline.found) continue;
            for (const d of outline.documents) {
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
