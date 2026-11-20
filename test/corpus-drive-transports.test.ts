import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  createCanonicalConnection,
  deleteConnectionsForCorpus,
  listProjectConnections,
} from "../src/control/connections";
import { connectControlDb } from "../src/control/db";
import { ValidationError } from "../src/errors";
import {
  asCallerRef,
  asCorpusSlug,
  asDocumentSlug,
  asProjectId,
} from "../src/ids";
import { handleMcp, RpcSchema } from "../src/mcp";
import { scopedExecutor } from "../src/scoped-executor";
import { DEFAULT_CORPUS_SLUG } from "../src/store/domain/default-corpus";

import { createOrg, freshStore, signUp } from "./_helpers";

const AUTHOR = "transport-test";
const ALPHA = asCorpusSlug("alpha");
const BETA = asCorpusSlug("beta");
const AGENT = asCallerRef("apikey:agent-a");
const LOCATION = {
  baseUrl: "http://localhost:8787",
  projectId: asProjectId("test-project"),
} as const;

type Rpc = Readonly<{
  result?: {
    content?: { text: string }[];
    tools?: { name: string; description: string }[];
    instructions?: string;
  };
  error?: { code: number; message: string };
}>;

// alpha holds `docs/a.md` and `README.md`; beta holds `README.md` and
// `b.md`; a draft sits in the default corpus. The executor is bound to alpha.
async function setup() {
  const store = freshStore("drive-mcp");
  await store.createCorpus({ slug: ALPHA, name: "Alpha", changedBy: AUTHOR });
  await store.createCorpus({ slug: BETA, name: "Beta", changedBy: AUTHOR });
  await store.ensureDefaultCorpus(AUTHOR);
  const place = async (corpus: typeof ALPHA, path: string, body: string) => {
    const r = await store.importDocumentAtPath({
      corpusSlug: corpus,
      path,
      markdown: body,
      changedBy: AUTHOR,
    });
    expect(r.ok, `importing ${path}`).toBe(true);
  };
  await place(ALPHA, "docs/a.md", "# A");
  await place(ALPHA, "README.md", "# Alpha readme");
  await place(BETA, "README.md", "# Beta readme");
  await place(BETA, "b.md", "# B");
  await place(DEFAULT_CORPUS_SLUG, "draft.md", "# Draft");
  const members = (await store.corpusMembers(ALPHA)) ?? [];
  const exec = scopedExecutor(store, ALPHA, members, AGENT, LOCATION);
  return { store, exec, members };
}

function rpc(exec: Awaited<ReturnType<typeof setup>>["exec"], body: object) {
  return handleMcp(
    RpcSchema.parse({ jsonrpc: "2.0", id: 1, ...body }),
    exec,
  ) as Promise<Rpc>;
}

describe("MCP: a corpus is a folder of markdown files", () => {
  it("tells the agent so at initialize", async () => {
    const { exec } = await setup();
    const res = await rpc(exec, { method: "initialize" });
    expect(res.result?.instructions).toContain("folder of markdown files");
    expect(res.result?.instructions).toContain("list_documents");
  });

  it("has no assembled read-the-whole-corpus tool and no core/reference vocabulary", async () => {
    const { exec } = await setup();
    const res = await rpc(exec, { method: "tools/list" });
    const tools = res.result?.tools ?? [];
    expect(tools.map((t) => t.name)).not.toContain("read_collection");
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["list_documents", "read_document"]),
    );
    for (const tool of tools) {
      expect(tool.description.toLowerCase()).not.toMatch(
        /delivery|always include|reference documents|core guidance/u,
      );
    }
  });

  it("lists only the bound corpus's files, lexically by corpus-relative path, with no delivery field", async () => {
    const { exec } = await setup();
    const res = await rpc(exec, {
      method: "tools/call",
      params: { name: "list_documents", arguments: {} },
    });
    const rows = JSON.parse(res.result?.content?.[0]?.text ?? "[]") as Record<
      string,
      unknown
    >[];
    expect(rows.map((r) => r.path)).toEqual(["README.md", "docs/a.md"]);
    for (const row of rows) expect(row).not.toHaveProperty("delivery");
  });

  it("reads a file by path inside the corpus, and the other corpus's README is not reachable by that path", async () => {
    const { exec } = await setup();
    const read = async (path: string) =>
      rpc(exec, {
        method: "tools/call",
        params: { name: "read_document", arguments: { path } },
      });
    expect((await read("README.md")).result?.content?.[0]?.text).toBe(
      "# Alpha readme",
    );
    expect((await read("docs/a.md")).result?.content?.[0]?.text).toBe("# A");
    expect((await read("b.md")).error).toBeDefined();
  });

  it("does not offer the assembled collection resource", async () => {
    const { exec } = await setup();
    const res = await rpc(exec, {
      method: "resources/read",
      params: { uri: "collection://alpha" },
    });
    expect(res.error).toBeDefined();
  });

  it("cannot read a document that was moved out of its corpus after the request began", async () => {
    const { store, exec } = await setup();
    const slug = asDocumentSlug("a");
    const [moved] = (await store.listDocuments()).filter(
      (d) => d.path === "docs/a.md",
    );
    expect(moved?.corpusSlug).toBe(ALPHA);
    await store.moveDocument(
      asDocumentSlug(moved?.slug ?? slug),
      { corpusSlug: BETA, folderSlug: null },
      AUTHOR,
    );
    // `exec` still holds the member snapshot from before the move; the
    // write path re-checks where the document is now.
    const res = await rpc(exec, {
      method: "tools/call",
      params: {
        name: "suggest_edit",
        arguments: {
          slug: moved?.slug,
          proposedMarkdown: "# A changed",
          baseDocVersion: 1,
        },
      },
    });
    expect(res.error).toBeDefined();
    expect(
      await store.listSuggestions(asDocumentSlug(moved?.slug ?? slug)),
    ).toHaveLength(0);
  });
});

describe("Connections and the drafts space", () => {
  it("the default corpus cannot be bound to a Connection", async () => {
    const userId = await signUp("drive-bind");
    const org = await createOrg(userId, "Org bind");
    await expect(
      createCanonicalConnection(connectControlDb(env.DB), {
        organizationId: org.organizationId,
        projectId: org.projectId,
        corpusSlug: DEFAULT_CORPUS_SLUG,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("deleting a corpus's Connections is scoped by (project, corpus): another project's Connection on the same slug is untouched", async () => {
    const userId = await signUp("drive-del");
    const db = connectControlDb(env.DB);
    const mine = await createOrg(userId, "Org mine");
    const theirs = await createOrg(await signUp("drive-del2"), "Org theirs");
    for (const org of [mine, theirs]) {
      await createCanonicalConnection(db, {
        organizationId: org.organizationId,
        projectId: org.projectId,
        corpusSlug: ALPHA,
      });
      await createCanonicalConnection(db, {
        organizationId: org.organizationId,
        projectId: org.projectId,
        corpusSlug: BETA,
      });
    }

    expect(
      await deleteConnectionsForCorpus(db, {
        projectId: mine.projectId,
        corpusSlug: ALPHA,
      }),
    ).toBe(1);

    expect(
      (await listProjectConnections(db, mine.projectId)).map(
        (c) => c.corpusSlug,
      ),
    ).toEqual([BETA]);
    expect(await listProjectConnections(db, theirs.projectId)).toHaveLength(2);
    // Idempotent: a second run has nothing left to delete.
    expect(
      await deleteConnectionsForCorpus(db, {
        projectId: mine.projectId,
        corpusSlug: ALPHA,
      }),
    ).toBe(0);
  });
});
