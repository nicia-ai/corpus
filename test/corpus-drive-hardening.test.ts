import { env, runInDurableObject } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  createCanonicalConnection,
  listProjectConnections,
} from "../src/control/connections";
import {
  createCorpusClean,
  deleteCorpusAndCredentials,
} from "../src/control/corpus-lifecycle";
import { connectControlDb } from "../src/control/db";
import { connection } from "../src/control/schema/app";
import { storeFor } from "../src/control/store-for";
import {
  asCallerRef,
  asCorpusSlug,
  asDocumentSlug,
  asFolderSlug,
  asProjectId,
} from "../src/ids";
import { handleMcp, RpcSchema } from "../src/mcp";
import type { ProjectStore } from "../src/project-store";
import { checkedPathSegments } from "../src/project-store/commands/untrusted-path";
import { scopedExecutor } from "../src/scoped-executor";
import { DEFAULT_CORPUS_SLUG } from "../src/store/domain/default-corpus";
import type { CorpusStore } from "../src/store/handle";
import { setGraphStatementSinkForTest } from "../src/store/statement-log";

import { createOrg, docSlug, freshStore, signUp } from "./_helpers";
import {
  ALPHA,
  AUTHOR,
  BETA,
  type LegacyInstance,
  seedLegacyProject,
  SHARED,
  type Store,
} from "./_legacy-shape";

// Hardening of the drive migration and its edges.

const MARKER_KEY = "layout:corpus-drive:v1";
const CREATED_AT = "2020-01-01T00:00:00.000Z";

type Seam = LegacyInstance & {
  layoutTestSeam: {
    batchSize?: number;
    afterBatch?: (committedBatches: number) => void;
  };
};

async function inDo<T>(
  store: Store,
  fn: (s: CorpusStore, instance: Seam) => Promise<T>,
): Promise<T> {
  return runInDurableObject(store, async (instance) => {
    const inst = instance as unknown as Seam;
    return fn(await inst.ensureStore(), inst);
  });
}

// `count` documents in ONE flat legacy folder `bulk`, all selected by corpus
// alpha through a folder link — the shape that made placement quadratic.
async function seedFlatLegacy(store: Store, count: number): Promise<void> {
  await inDo(store, async (s) => {
    await s.transaction(async (tx) => {
      const corpus = await tx.nodes.Collection.create({
        slug: ALPHA,
        name: "Alpha",
      });
      const folder = await tx.nodes.Folder.create({
        slug: "bulk",
        name: "bulk",
        createdAt: CREATED_AT,
      });
      await tx.edges.includes_folder.create(
        { kind: "Collection", id: corpus.id },
        { kind: "Folder", id: folder.id },
        { position: 1, delivery: "core" },
      );
      for (let i = 0; i < count; i += 1) {
        const doc = await tx.nodes.Document.create({
          slug: `flat-${String(i)}`,
          title: `Flat ${String(i)}`,
          filename: `flat-${String(i)}.md`,
          contentHash: `hash-${String(i)}`,
          docVersion: 1,
          updatedAt: CREATED_AT,
        });
        await tx.edges.in_folder.create(
          { kind: "Document", id: doc.id },
          { kind: "Folder", id: folder.id },
          { position: i },
        );
      }
    });
  });
}

// What a ProjectStore call throws, read INSIDE the Durable Object: an error
// that crosses the RPC boundary is reported by the test pool as an unhandled
// rejection even when the test catches it.
async function failureOf(
  store: Store,
  call: (instance: ProjectStore) => Promise<unknown>,
): Promise<string> {
  return runInDurableObject(store, async (instance: ProjectStore) => {
    try {
      await call(instance);
      return "no error";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
}

async function measure<T>(
  fn: () => Promise<T>,
): Promise<Readonly<{ result: T; statements: number }>> {
  let statements = 0;
  const restore = setGraphStatementSinkForTest(() => {
    statements += 1;
  });
  try {
    return { result: await fn(), statements };
  } finally {
    restore();
  }
}

describe("layout migration at scale", () => {
  it("costs statements linear in the number of documents, many in one flat folder, across batches", async () => {
    const SMALL = 60;
    const LARGE = 240;
    const BATCH = 50;
    const run = async (count: number) => {
      const store = freshStore("drive-scale");
      await seedFlatLegacy(store, count);
      await inDo(store, (_s, inst) => {
        inst.layoutTestSeam.batchSize = BATCH;
        return Promise.resolve();
      });
      const m = await measure(() => store.listDocumentRefs());
      expect(m.result).toHaveLength(count);
      expect(new Set(m.result.map((d) => d.corpusSlug))).toEqual(
        new Set([ALPHA]),
      );
      expect(m.result[0]?.path).toMatch(/^bulk\/flat-\d+\.md$/u);
      return m.statements;
    };
    const small = await run(SMALL);
    const large = await run(LARGE);
    // Per-document cost may not grow with the project: linear total means
    // the per-document figure is flat (or shrinks as fixed costs amortize).
    expect(large / LARGE).toBeLessThanOrEqual((small / SMALL) * 1.25);
  });

  it("a failure between batches leaves a state the next call completes, with nothing duplicated", async () => {
    const clean = freshStore("drive-clean");
    await seedLegacyProject(clean);
    const placed = async (s: Store) =>
      (await s.listDocuments()).map((d) => [d.slug, d.corpusSlug, d.path]);
    const expected = await placed(clean);

    const store = freshStore("drive-crash");
    await seedLegacyProject(store);
    await inDo(store, (_s, inst) => {
      inst.layoutTestSeam.batchSize = 2;
      let crashed = false;
      inst.layoutTestSeam.afterBatch = () => {
        if (crashed) return;
        crashed = true;
        throw new Error("simulated crash after batch 1");
      };
      return Promise.resolve();
    });
    expect(await failureOf(store, (i) => i.listDocuments())).toMatch(
      /simulated crash/u,
    );

    // Mid-way: the first batch is committed, the old links are still there
    // (they go with the LAST batch), and the marker is not set.
    await inDo(store, async (s) => {
      expect(await s.edges.includes.find({ limit: 10 })).toHaveLength(1);
      const links = await s.edges.includes_folder.find({ limit: 10 });
      const linked = await s.nodes.Folder.getByIds(links.map((l) => l.toId));
      expect(
        linked.filter((f) => !f?.slug.startsWith("corpus-root:")),
      ).toHaveLength(2);
      const roots = await s.nodes.Folder.find({
        where: (f) => f.slug.startsWith("corpus-root:"),
        limit: 10,
      });
      expect(roots.length).toBeGreaterThan(0);
    });
    await runInDurableObject(store, async (_i, state) => {
      expect(await state.storage.get(MARKER_KEY)).toBeUndefined();
    });

    // The next call (the crash hook no longer fires) finishes the job.
    expect(await placed(store)).toEqual(expected);
    await runInDurableObject(store, async (_i, state) => {
      expect(await state.storage.get(MARKER_KEY)).toBe(true);
    });
    const dropped = (await store.recentChanges(200)).filter(
      (c) => c.eventType === "collection.detached" && c.documentSlug === SHARED,
    );
    expect(dropped).toHaveLength(1);
    expect((await store.verifyHistory()).ok).toBe(true);
  });
});

describe("layout migration keeps the folders people made", () => {
  it("carries empty folders under the right root, in their old order", async () => {
    const store = freshStore("drive-empty");
    await seedLegacyProject(store);
    await inDo(store, async (s) => {
      await s.transaction(async (tx) => {
        const folder = async (slug: string) => {
          const [node] = await tx.nodes.Folder.find({
            where: (f) => f.slug.eq(slug),
            limit: 1,
          });
          if (node === undefined) throw new Error(`no folder ${slug}`);
          return { kind: "Folder" as const, id: node.id };
        };
        const make = async (
          slug: string,
          name: string,
          parent: string | null,
          position: number,
        ) => {
          const node = await tx.nodes.Folder.create({
            slug,
            name,
            createdAt: CREATED_AT,
          });
          if (parent !== null) {
            await tx.edges.folder_child.create(
              await folder(parent),
              { kind: "Folder", id: node.id },
              { position },
            );
          }
        };
        // Under `docs` (shared -> alpha, guide -> beta): two empty children,
        // deliberately NOT in alphabetical order. A wholly empty top-level
        // tree, and an empty child inside it.
        await make("docs-zeta", "zeta", "docs", 1);
        await make("docs-aardvark", "aardvark", "docs", 2);
        await make("reports", "reports", null, 1);
        await make("reports-q3", "q3", "reports", 1);
      });
    });
    // Re-arm the migration (seedLegacyProject armed it before these writes).
    await runInDurableObject(store, async (instance, state) => {
      (instance as unknown as LegacyInstance).driveLayout = undefined;
      await state.storage.delete(MARKER_KEY);
    });

    const folders = await store.listFolders();
    const where = (name: string) =>
      folders.filter((f) => f.name === name).map((f) => f.corpusSlug);
    // Empty folders under `docs` follow the earliest-created corpus there.
    expect(where("zeta")).toEqual([ALPHA]);
    expect(where("aardvark")).toEqual([ALPHA]);
    // A wholly empty top-level tree goes to drafts, nested folder with it.
    expect(where("reports")).toEqual([DEFAULT_CORPUS_SLUG]);
    expect(where("q3")).toEqual([DEFAULT_CORPUS_SLUG]);

    // Sibling order survives: `zeta` was before `aardvark`.
    const exported = await store.exportBundle({
      organization: "acme",
      project: "default",
    });
    const position = (name: string) =>
      exported.manifest.folders.find((f) => f.name === name)?.position ?? -1;
    expect(position("zeta")).toBeLessThan(position("aardvark"));
  });

  it("an archived page with the same file name as a live one never takes its path", async () => {
    const store = freshStore("drive-archived-collision");
    await seedLegacyProject(store);
    await inDo(store, async (s) => {
      await s.transaction(async (tx) => {
        const [docs] = await tx.nodes.Folder.find({
          where: (f) => f.slug.eq("docs"),
          limit: 1,
        });
        if (docs === undefined) throw new Error("no docs folder");
        const old = await tx.nodes.Document.create({
          slug: "shared-old",
          title: "Shared (old)",
          filename: "shared.md",
          contentHash: "hash-old",
          docVersion: 1,
          updatedAt: CREATED_AT,
          archivedAt: CREATED_AT,
        });
        await tx.edges.in_folder.create(
          { kind: "Document", id: old.id },
          { kind: "Folder", id: docs.id },
          { position: 9 },
        );
      });
    });
    await runInDurableObject(store, async (instance, state) => {
      (instance as unknown as LegacyInstance).driveLayout = undefined;
      await state.storage.delete(MARKER_KEY);
    });

    // The live page keeps the path; the archived one is not listed and
    // takes no part in path resolution.
    const atPath = (await store.listDocuments()).filter(
      (d) => d.path === "docs/shared.md",
    );
    expect(atPath.map((d) => d.slug)).toEqual([SHARED]);
    const imported = await store.importDocumentAtPath({
      corpusSlug: ALPHA,
      path: "docs/shared.md",
      markdown: "# Shared\nv3",
      changedBy: AUTHOR,
    });
    expect(imported).toMatchObject({
      ok: true,
      created: false,
      slug: SHARED,
    });
    expect(await store.getDocument(docSlug("shared-old"))).toBeUndefined();
  });
});

describe("a project that served its default corpus", () => {
  async function seedBound(bind: boolean) {
    const org = await createOrg(await signUp("drive-bound"), "Org bound");
    const store = storeFor(env, org.projectId);
    await seedLegacyProject(store);
    const db = connectControlDb(env.DB);
    if (bind) {
      await db.insert(connection).values({
        organizationId: org.organizationId,
        projectId: org.projectId,
        collectionSlug: DEFAULT_CORPUS_SLUG,
        name: "default",
        isDefaultForCollection: true,
      });
    }
    return { org, store, db };
  }

  it("keeps it served: the pages become a named corpus, the credentials follow, drafts start empty", async () => {
    const { org, store, db } = await seedBound(true);

    const located = new Map(
      (await store.listDocuments()).map((d) => [d.slug, d] as const),
    );
    const loose = located.get("loose");
    expect(loose?.corpusSlug).not.toBe(DEFAULT_CORPUS_SLUG);
    const promoted = asCorpusSlug(loose?.corpusSlug ?? "");
    expect(await store.corpusMembers(promoted)).toEqual(["loose"]);
    expect(await store.isDocumentServed(docSlug("loose"))).toBe(true);
    expect(await store.corpusMembers(DEFAULT_CORPUS_SLUG)).toEqual([]);
    expect((await store.corpusMeta(promoted)).found).toBe(true);

    const rows = await listProjectConnections(db, org.projectId);
    expect(rows.map((r) => r.corpusSlug)).toEqual([promoted]);
    // Still resolvable: nothing is left bound to drafts.
    expect(
      await db
        .select({ id: connection.id })
        .from(connection)
        .where(
          and(
            eq(connection.projectId, org.projectId),
            eq(connection.collectionSlug, DEFAULT_CORPUS_SLUG),
          ),
        ),
    ).toEqual([]);
  });

  it("leaves the default corpus alone when no credential is bound to it", async () => {
    const { store } = await seedBound(false);
    const loose = (await store.listDocuments()).find((d) => d.slug === "loose");
    expect(loose?.corpusSlug).toBe(DEFAULT_CORPUS_SLUG);
    expect((await store.listCorpora()).map((c) => c.slug)).toEqual(
      expect.not.arrayContaining(["general"]),
    );
  });
});

describe("untrusted paths", () => {
  it("rejects anything that could leave the corpus, accepts ordinary relative paths", () => {
    for (const bad of [
      "../x.md",
      "a/../../x.md",
      "a/ .. /x.md",
      "/etc/x.md",
      "C:/x.md",
      "a\\b.md",
      "a/\u0000b.md",
      "a/\u001fb.md",
    ]) {
      expect(() => checkedPathSegments(bad)).toThrow();
    }
    expect(checkedPathSegments("./a//b/c.md")).toEqual(["a", "b", "c.md"]);
  });

  it("an upload with one escaping path is refused whole, writing nothing", async () => {
    const store = freshStore("drive-upload-dotdot");
    expect(
      await failureOf(store, (i) =>
        i.importIntoCorpus({
          entries: [
            { path: "fine.md", markdown: "# Fine" },
            { path: "../evil.md", markdown: "# Evil" },
          ],
          destination: { mode: "default" },
          changedBy: AUTHOR,
        }),
      ),
    ).toMatch(/“\.\.”/u);
    expect(await store.listDocuments()).toEqual([]);
    expect(await store.listFolders()).toEqual([]);
  });

  it("an agent's create-proposal with an escaping path is invalid and files nothing", async () => {
    const store = freshStore("drive-proposal-dotdot");
    await store.createCorpus({ slug: ALPHA, name: "Alpha", changedBy: AUTHOR });
    const exec = scopedExecutor(store, ALPHA, [], asCallerRef("apikey:agent"), {
      baseUrl: "http://localhost",
      projectId: asProjectId("p"),
    });
    const res = (await handleMcp(
      RpcSchema.parse({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "suggest_edit",
          arguments: {
            slug: "sneaky",
            path: "../../outside/x.md",
            proposedMarkdown: "# x",
            baseDocVersion: 0,
          },
        },
      }),
      exec,
    )) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32602);
    expect(await store.listCreateProposals()).toHaveLength(0);
  });
});

describe("reads that used to skip the migration", () => {
  it("search finds pages in a project that has not been laid out yet", async () => {
    const store = freshStore("drive-search");
    await seedLegacyProject(store);
    const hits = await store.searchDocuments("Shared");
    expect(hits.map((h) => h.slug)).toContain(SHARED);
    expect(hits.find((h) => h.slug === SHARED)?.corpusSlug).toBe(ALPHA);
  });
});

describe("activity noise", () => {
  it("creating a document records its own event but no corpus 'reordered' row", async () => {
    const store = freshStore("drive-noise");
    await store.createCorpus({ slug: ALPHA, name: "Alpha", changedBy: AUTHOR });
    const r = await store.saveDocument({
      slug: docSlug("note"),
      markdown: "# Note",
      location: { corpusSlug: ALPHA, folderSlug: null },
      clientVersion: 0,
      changedBy: AUTHOR,
    });
    expect(r.ok).toBe(true);
    await store.archiveDocument(docSlug("note"), AUTHOR);
    const kinds = (await store.recentChanges(50)).map((c) => c.eventType);
    expect(kinds).toContain("document.created");
    expect(kinds).toContain("document.archived");
    expect(kinds).not.toContain("collection.reordered");
  });
});

describe("proposal scope follows the document", () => {
  it("a reply or result lookup is refused once the document has left the corpus", async () => {
    const store = freshStore("drive-reply-scope");
    await store.createCorpus({ slug: ALPHA, name: "Alpha", changedBy: AUTHOR });
    await store.createCorpus({ slug: BETA, name: "Beta", changedBy: AUTHOR });
    const slug = docSlug("page");
    await store.saveDocument({
      slug,
      markdown: "# Page\nbody",
      location: { corpusSlug: ALPHA, folderSlug: null },
      clientVersion: 0,
      changedBy: AUTHOR,
    });
    const caller = asCallerRef("apikey:agent");
    const exec = scopedExecutor(store, ALPHA, ["page"], caller, {
      baseUrl: "http://localhost",
      projectId: asProjectId("p"),
    });
    const made = await exec.suggestEdit(caller, slug, "# Page\nnew body", 1);
    if (!("suggestionId" in made) || made.suggestionId === null) {
      throw new Error(`no proposal: ${JSON.stringify(made)}`);
    }
    const id = made.suggestionId;
    expect(await exec.replyToProposal(caller, id, "still here")).toMatchObject({
      ok: true,
    });
    expect(await exec.proposalResult(caller, id)).toMatchObject({
      found: true,
    });

    await store.moveDocument(
      slug,
      { corpusSlug: BETA, folderSlug: null },
      AUTHOR,
    );

    expect(await exec.replyToProposal(caller, id, "too late")).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(await exec.proposalResult(caller, id)).toEqual({ found: false });
  });
});

describe("corpus deletion and credentials", () => {
  async function bound(slug: string) {
    const org = await createOrg(await signUp("drive-cred"), "Org cred");
    const db = connectControlDb(env.DB);
    await createCanonicalConnection(db, {
      organizationId: org.organizationId,
      projectId: org.projectId,
      corpusSlug: asCorpusSlug(slug),
    });
    return { org, db };
  }

  it("a failing ProjectStore leaves the corpus's credentials in place", async () => {
    const { org, db } = await bound("alpha");
    const store = {
      deleteCorpus: () => Promise.reject(new Error("store down")),
      corpusMeta: () => Promise.resolve({ found: true }),
      createCorpus: () => Promise.resolve({ slug: ALPHA }),
    };
    await expect(
      deleteCorpusAndCredentials({
        db,
        store,
        projectId: org.projectId,
        input: { slug: ALPHA, pages: "archive", changedBy: AUTHOR },
      }),
    ).rejects.toThrow(/store down/u);
    expect(await listProjectConnections(db, org.projectId)).toHaveLength(1);
  });

  it("removes the credentials once the store has deleted it — and even when the corpus was already gone", async () => {
    const { org, db } = await bound("alpha");
    const store = freshStore("drive-cred-del");
    const outcome = await deleteCorpusAndCredentials({
      db,
      store,
      projectId: org.projectId,
      input: { slug: ALPHA, pages: "archive", changedBy: AUTHOR },
    });
    expect(outcome).toEqual({ ok: false, reason: "missing" });
    expect(await listProjectConnections(db, org.projectId)).toEqual([]);
  });

  it("refuses the default corpus before touching anything", async () => {
    const { org, db } = await bound("alpha");
    const outcome = await deleteCorpusAndCredentials({
      db,
      store: freshStore("drive-cred-default"),
      projectId: org.projectId,
      input: {
        slug: DEFAULT_CORPUS_SLUG,
        pages: "archive",
        changedBy: AUTHOR,
      },
    });
    expect(outcome).toEqual({ ok: false, reason: "default-corpus" });
    expect(await listProjectConnections(db, org.projectId)).toHaveLength(1);
  });

  it("a new corpus on a slug with leftover credentials does not inherit them; an existing corpus keeps its own", async () => {
    const { org, db } = await bound("alpha");
    const store = freshStore("drive-cred-create");
    await createCorpusClean({
      db,
      store,
      projectId: org.projectId,
      corpus: { slug: ALPHA, name: "Alpha", changedBy: AUTHOR },
    });
    expect(await listProjectConnections(db, org.projectId)).toEqual([]);

    await createCanonicalConnection(db, {
      organizationId: org.organizationId,
      projectId: org.projectId,
      corpusSlug: ALPHA,
    });
    await createCorpusClean({
      db,
      store,
      projectId: org.projectId,
      corpus: { slug: ALPHA, name: "Alpha", changedBy: AUTHOR },
    });
    expect(await listProjectConnections(db, org.projectId)).toHaveLength(1);
  });

  it("'move to drafts' keeps the pages in a folder named for the corpus's display name, made path-safe", async () => {
    const store = freshStore("drive-delete-name");
    await store.createCorpus({ slug: ALPHA, name: "Alpha", changedBy: AUTHOR });
    await store.updateCorpus({
      slug: ALPHA,
      name: "Q3 / Plans",
      changedBy: AUTHOR,
    });
    await store.saveDocument({
      slug: docSlug("plan"),
      markdown: "# Plan",
      location: { corpusSlug: ALPHA, folderSlug: null },
      clientVersion: 0,
      changedBy: AUTHOR,
    });
    await store.deleteCorpus({
      slug: ALPHA,
      pages: "move-to-default",
      changedBy: AUTHOR,
    });
    const [plan] = await store.listDocuments();
    expect(plan?.path).toBe("Q3 Plans/plan.md");
    expect(plan?.corpusSlug).toBe(DEFAULT_CORPUS_SLUG);
  });
});

describe("bundle import never leaves a live document outside every root", () => {
  it("brings an archived, folderless page back archived, and every live page under a root", async () => {
    const source = freshStore("drive-bundle-src");
    await source.createCorpus({
      slug: ALPHA,
      name: "Alpha",
      changedBy: AUTHOR,
    });
    const folder = await source.createFolder("docs", {
      corpusSlug: ALPHA,
      folderSlug: null,
    });
    if (!folder.ok) throw new Error("setup");
    for (const [slug, path] of [
      ["kept", "keep.md"],
      ["doomed", "docs/doomed.md"],
    ] as const) {
      const r = await source.importDocumentAtPath({
        corpusSlug: ALPHA,
        path,
        markdown: `# ${slug}`,
        changedBy: AUTHOR,
      });
      expect(r.ok).toBe(true);
    }
    await source.deleteFolder(asFolderSlug(folder.slug), AUTHOR);
    const bundle = await source.exportBundle({
      organization: "acme",
      project: "default",
    });
    const archivedEntry = bundle.manifest.documents.find(
      (d) => d.folderSlug === null,
    );
    expect(archivedEntry).toBeDefined();

    const target = freshStore("drive-bundle-dst");
    expect((await target.importBundle(bundle)).ok).toBe(true);

    const live = await target.listDocuments();
    expect(live.map((d) => d.path)).toEqual(["keep.md"]);
    expect(await target.getDocument(asDocumentSlug("doomed"))).toBeUndefined();
    // Every live document is in exactly one corpus.
    const members: string[] = [];
    for (const c of await target.listCorpora()) {
      members.push(
        ...((await target.corpusMembers(asCorpusSlug(c.slug))) ?? []),
      );
    }
    expect(members.sort()).toEqual(live.map((d) => d.slug).sort());
  });
});
