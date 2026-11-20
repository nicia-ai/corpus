import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  CliError,
  type FetchLike,
  pull,
  push,
  readClientVersion,
  sidecarPath,
} from "../cli/core";
import { formatSyncReport, pullAll, type SyncReport } from "../cli/sync";
import {
  serializeState,
  sha256Hex,
  STATE_FILE,
  STATE_VERSION,
  unsafePathProblem,
} from "../cli/sync-state";
import { storeFor } from "../src/control/store-for";
import { asFolderSlug } from "../src/ids";

import {
  configFor,
  DIR,
  edit,
  type MemoryTree,
  memoryTree,
  moveOut,
  newCorpus,
  OWNER,
  seed,
  siblingCorpus,
} from "./_cli-fixtures";
import { docSlug } from "./_helpers";

const at = (path: string): string => `${DIR}/${path}`;

function paths(changes: readonly { path: string }[]): readonly string[] {
  return changes.map((c) => c.path);
}

// The state file as a parsed object, for readable assertions.
function stateOf(files: MemoryTree): {
  version: number;
  corpus: { projectId: string; slug: string };
  files: { path: string; slug: string; docVersion: number; sha256: string }[];
} {
  return JSON.parse(files.map.get(at(STATE_FILE)) ?? "null");
}

// Rewrite the listing the CLI sees, to model a server returning hostile paths.
function listingRewrite(
  rewrite: (paths: readonly string[]) => readonly string[],
): FetchLike {
  return async (input, init) => {
    const res = await SELF.fetch(input, init);
    if (new URL(input).pathname !== "/api/v1/docs") return res;
    const body: {
      documents: { path: string }[];
    } = await res.json();
    const next = rewrite(body.documents.map((d) => d.path));
    return Response.json({
      ...body,
      documents: body.documents.map((d, i) => ({ ...d, path: next[i] })),
    });
  };
}

describe("corpus pull --all (whole-corpus sync)", () => {
  it("first pull into an empty directory writes every document at its path", async () => {
    const corpus = await newCorpus();
    await seed(corpus, "readme", "# Readme\n");
    await seed(corpus, "deploy", "# Deploy\n\nsteps\n", "runbooks");
    const files = memoryTree();

    const report = await pullAll(configFor(corpus, files), DIR);

    expect(paths(report.added)).toEqual(["readme.md", "runbooks/deploy.md"]);
    expect(report.updated).toEqual([]);
    expect(report.conflicts).toEqual([]);
    expect(files.map.get(at("readme.md"))).toBe("# Readme\n");
    expect(files.map.get(at("runbooks/deploy.md"))).toBe("# Deploy\n\nsteps\n");
    const state = stateOf(files);
    expect(state.version).toBe(STATE_VERSION);
    expect(state.corpus).toEqual({
      projectId: corpus.projectId,
      slug: corpus.corpusSlug,
    });
    expect(state.files).toEqual([
      {
        path: "readme.md",
        slug: "readme",
        docVersion: 1,
        sha256: await sha256Hex("# Readme\n"),
      },
      {
        path: "runbooks/deploy.md",
        slug: "deploy",
        docVersion: 1,
        sha256: await sha256Hex("# Deploy\n\nsteps\n"),
      },
    ]);
    expect(formatSyncReport(report, DIR)[0]).toBe(
      "added 2, updated 0, removed 0, unchanged 0",
    );
  });

  it("second run with no upstream change writes nothing and says up to date", async () => {
    const corpus = await newCorpus();
    await seed(corpus, "a", "# A\n");
    await seed(corpus, "b", "# B\n", "docs");
    const files = memoryTree();
    const cfg = configFor(corpus, files);
    await pullAll(cfg, DIR);
    const stateBefore = files.map.get(at(STATE_FILE));
    files.writes.length = 0;

    const report = await pullAll(cfg, DIR);

    expect(files.writes).toEqual([]);
    expect(files.removes).toEqual([]);
    expect(files.map.get(at(STATE_FILE))).toBe(stateBefore);
    expect(report.unchanged).toHaveLength(2);
    expect(formatSyncReport(report, DIR)).toEqual([
      `up to date: 2 files in ${DIR}`,
    ]);
  });

  it("applies an upstream update and records the new version and hash", async () => {
    const corpus = await newCorpus();
    await seed(corpus, "guide", "v1\n");
    const files = memoryTree();
    const cfg = configFor(corpus, files);
    await pullAll(cfg, DIR);
    await edit(corpus, "guide", "v2\n", 1);

    const report = await pullAll(cfg, DIR);

    expect(paths(report.updated)).toEqual(["guide.md"]);
    expect(files.map.get(at("guide.md"))).toBe("v2\n");
    expect(stateOf(files).files[0]).toMatchObject({
      docVersion: 2,
      sha256: await sha256Hex("v2\n"),
    });
  });

  it("removes a document dropped from the corpus, but never an untracked file", async () => {
    const corpus = await newCorpus();
    await seed(corpus, "keep", "keep\n");
    await seed(corpus, "drop", "drop\n");
    const files = memoryTree();
    const cfg = configFor(corpus, files);
    await pullAll(cfg, DIR);
    files.map.set(at("notes.txt"), "mine");
    await moveOut(corpus, "drop");

    const report = await pullAll(cfg, DIR);

    expect(report.removed).toEqual(["drop.md"]);
    expect(files.map.has(at("drop.md"))).toBe(false);
    expect(files.map.get(at("keep.md"))).toBe("keep\n");
    expect(files.map.get(at("notes.txt"))).toBe("mine");
    expect(stateOf(files).files.map((f) => f.path)).toEqual(["keep.md"]);
  });

  it("a document moved to another corpus disappears from the checkout; one moved in appears", async () => {
    const corpus = await newCorpus();
    const other = await siblingCorpus(corpus);
    await seed(corpus, "stays", "stays\n");
    await seed(corpus, "leaves", "leaves\n", "docs");
    await seed(other, "arrives", "arrives\n");
    const files = memoryTree();
    const cfg = configFor(corpus, files);
    await pullAll(cfg, DIR);
    expect(files.map.get(at("docs/leaves.md"))).toBe("leaves\n");

    await moveOut(corpus, "leaves", other.corpusSlug);
    const store = storeFor(env, corpus.projectId);
    await store.moveDocument(
      docSlug("arrives"),
      { corpusSlug: corpus.corpusSlug, folderSlug: null },
      OWNER,
    );
    const report = await pullAll(cfg, DIR);

    expect(report.removed).toEqual(["docs/leaves.md"]);
    expect(paths(report.added)).toEqual(["arrives.md"]);
    expect(files.map.has(at("docs/leaves.md"))).toBe(false);
    expect(files.map.get(at("arrives.md"))).toBe("arrives\n");
    expect(stateOf(files).files.map((f) => f.path)).toEqual([
      "arrives.md",
      "stays.md",
    ]);
  });

  it("an archived document disappears from the checkout", async () => {
    const corpus = await newCorpus();
    await seed(corpus, "keep", "keep\n");
    await seed(corpus, "bin", "bin\n");
    const files = memoryTree();
    const cfg = configFor(corpus, files);
    await pullAll(cfg, DIR);
    await storeFor(env, corpus.projectId).archiveDocument(
      docSlug("bin"),
      OWNER,
    );

    const report = await pullAll(cfg, DIR);

    expect(report.removed).toEqual(["bin.md"]);
    expect(stateOf(files).files.map((f) => f.path)).toEqual(["keep.md"]);
  });

  it("moves a renamed or re-foldered document and removes the old path", async () => {
    const corpus = await newCorpus();
    await seed(corpus, "plan", "plan\n");
    const files = memoryTree();
    const cfg = configFor(corpus, files);
    await pullAll(cfg, DIR);
    const store = storeFor(env, corpus.projectId);
    await store.renameFilename({
      slug: docSlug("plan"),
      filename: "roadmap.md",
      changedBy: OWNER,
    });

    const renamed = await pullAll(cfg, DIR);

    expect(renamed.updated).toEqual([{ path: "roadmap.md", from: "plan.md" }]);
    expect(files.map.has(at("plan.md"))).toBe(false);
    expect(files.map.get(at("roadmap.md"))).toBe("plan\n");
    expect(stateOf(files).files.map((f) => [f.path, f.slug])).toEqual([
      ["roadmap.md", "plan"],
    ]);

    const folder = await store.createFolder("strategy", {
      corpusSlug: corpus.corpusSlug,
      folderSlug: null,
    });
    if (!folder.ok) throw new Error("folder");
    await store.moveDocument(
      docSlug("plan"),
      { corpusSlug: corpus.corpusSlug, folderSlug: asFolderSlug(folder.slug) },
      OWNER,
    );
    const moved = await pullAll(cfg, DIR);
    expect(moved.updated).toEqual([
      { path: "strategy/roadmap.md", from: "roadmap.md" },
    ]);
    expect(files.map.has(at("roadmap.md"))).toBe(false);
    expect(files.map.get(at("strategy/roadmap.md"))).toBe("plan\n");
  });

  it("keeps a locally edited file whose upstream is unchanged, and exits clean", async () => {
    const corpus = await newCorpus();
    await seed(corpus, "doc", "original\n");
    const files = memoryTree();
    const cfg = configFor(corpus, files);
    await pullAll(cfg, DIR);
    files.map.set(at("doc.md"), "edited by an engineer\n");
    const stateBefore = files.map.get(at(STATE_FILE));

    const report = await pullAll(cfg, DIR);

    expect(files.map.get(at("doc.md"))).toBe("edited by an engineer\n");
    expect(report.keptLocal).toEqual(["doc.md"]);
    expect(report.conflicts).toEqual([]);
    expect(files.map.get(at(STATE_FILE))).toBe(stateBefore);
    expect(formatSyncReport(report, DIR).join("\n")).toContain(
      "kept 1 locally edited file(s)",
    );
  });

  it("conflicts on a local edit with changed upstream, yet applies the other files", async () => {
    const corpus = await newCorpus();
    await seed(corpus, "mine", "mine v1\n");
    await seed(corpus, "other", "other v1\n");
    const files = memoryTree();
    const cfg = configFor(corpus, files);
    await pullAll(cfg, DIR);
    files.map.set(at("mine.md"), "local edit\n");
    await edit(corpus, "mine", "mine v2\n", 1);
    await edit(corpus, "other", "other v2\n", 1);

    const report = await pullAll(cfg, DIR);

    expect(report.conflicts).toEqual([
      { slug: "mine", path: "mine.md", reason: "edited-locally" },
    ]);
    expect(files.map.get(at("mine.md"))).toBe("local edit\n");
    expect(files.map.get(at("other.md"))).toBe("other v2\n");
    const tracked = stateOf(files).files;
    expect(tracked.find((f) => f.slug === "mine")?.docVersion).toBe(1);
    expect(tracked.find((f) => f.slug === "other")?.docVersion).toBe(2);
    const text = formatSyncReport(report, DIR).join("\n");
    expect(text).toContain("1 conflict(s), left untouched");
    expect(text).toContain("--overwrite");
  });

  it("does not delete a locally edited file that was removed upstream", async () => {
    const corpus = await newCorpus();
    await seed(corpus, "gone", "gone\n");
    const files = memoryTree();
    const cfg = configFor(corpus, files);
    await pullAll(cfg, DIR);
    files.map.set(at("gone.md"), "gone, but edited\n");
    await moveOut(corpus, "gone");

    const report = await pullAll(cfg, DIR);

    expect(report.conflicts).toEqual([
      { slug: "gone", path: "gone.md", reason: "deleted-upstream" },
    ]);
    expect(files.map.get(at("gone.md"))).toBe("gone, but edited\n");
    expect(stateOf(files).files.map((f) => f.path)).toEqual(["gone.md"]);
  });

  it("refuses an untracked file in the way, but adopts one with identical bytes", async () => {
    const corpus = await newCorpus();
    await seed(corpus, "clash", "upstream\n");
    await seed(corpus, "same", "identical\n");
    const files = memoryTree();
    files.map.set(at("clash.md"), "someone else's file\n");
    files.map.set(at("same.md"), "identical\n");

    const report = await pullAll(configFor(corpus, files), DIR);

    expect(report.conflicts).toEqual([
      { slug: "clash", path: "clash.md", reason: "untracked-in-the-way" },
    ]);
    expect(files.map.get(at("clash.md"))).toBe("someone else's file\n");
    expect(report.unchanged).toEqual(["same.md"]);
    expect(files.writes).toEqual([at(STATE_FILE)]);
    expect(stateOf(files).files.map((f) => f.path)).toEqual(["same.md"]);
  });

  it("--overwrite replaces conflicting, untracked and locally edited files", async () => {
    const corpus = await newCorpus();
    await seed(corpus, "mine", "mine v1\n");
    await seed(corpus, "clash", "upstream\n");
    await seed(corpus, "gone", "gone\n");
    const files = memoryTree();
    const cfg = configFor(corpus, files);
    files.map.set(at("clash.md"), "untracked\n");
    await pullAll(cfg, DIR);
    files.map.set(at("mine.md"), "local edit\n");
    await edit(corpus, "mine", "mine v2\n", 1);
    files.map.set(at("gone.md"), "edited\n");
    await moveOut(corpus, "gone");

    const report = await pullAll(cfg, DIR, { overwrite: true });

    expect(report.conflicts).toEqual([]);
    expect(files.map.get(at("mine.md"))).toBe("mine v2\n");
    expect(files.map.get(at("clash.md"))).toBe("upstream\n");
    expect(files.map.has(at("gone.md"))).toBe(false);
    expect(stateOf(files).files.map((f) => f.path)).toEqual([
      "clash.md",
      "mine.md",
    ]);
  });

  it("restores a tracked file deleted locally when upstream is unchanged", async () => {
    const corpus = await newCorpus();
    await seed(corpus, "doc", "text\n");
    const files = memoryTree();
    const cfg = configFor(corpus, files);
    await pullAll(cfg, DIR);
    files.map.delete(at("doc.md"));

    const report = await pullAll(cfg, DIR);

    expect(paths(report.added)).toEqual(["doc.md"]);
    expect(files.map.get(at("doc.md"))).toBe("text\n");
  });

  it("rejects document paths that would escape the directory, before writing anything", async () => {
    const corpus = await newCorpus();
    await seed(corpus, "safe", "safe\n");
    const outcomes: {
      hostile: string;
      isCliError: boolean;
      kind: string | undefined;
      writes: number;
    }[] = [];
    for (const hostile of [
      "../evil.md",
      "/etc/passwd",
      "a/../../b.md",
      "C:/win.md",
      "dir\\x.md",
      ".git/hooks/pre-commit",
      ".corpus.json",
    ]) {
      const files = memoryTree();
      const cfg = configFor(
        corpus,
        files,
        listingRewrite(() => [hostile]),
      );
      const err = await pullAll(cfg, DIR).catch((e: unknown) => e);
      outcomes.push({
        hostile,
        isCliError: err instanceof CliError,
        kind: err instanceof CliError ? err.kind : undefined,
        writes: files.writes.length,
      });
    }
    expect(outcomes.filter((o) => o.kind !== "unsafe-path")).toEqual([]);
    expect(outcomes.map((o) => o.writes)).toEqual(outcomes.map(() => 0));
  });

  it("detects case-insensitive path collisions", async () => {
    const corpus = await newCorpus();
    await seed(corpus, "one", "1\n");
    await seed(corpus, "two", "2\n");
    const files = memoryTree();
    const cfg = configFor(
      corpus,
      files,
      listingRewrite(() => ["Notes.md", "notes.md"]),
    );
    await expect(pullAll(cfg, DIR)).rejects.toMatchObject({
      kind: "unsafe-path",
    });
    expect(files.writes).toEqual([]);
  });

  it("rejects a tampered state file that tracks an escaping path", async () => {
    const corpus = await newCorpus();
    await seed(corpus, "doc", "x\n");
    const files = memoryTree();
    files.map.set(
      at(STATE_FILE),
      JSON.stringify({
        version: STATE_VERSION,
        corpus: { projectId: corpus.projectId, slug: corpus.corpusSlug },
        files: [
          {
            path: "../victim",
            slug: "x",
            docVersion: 1,
            sha256: "0".repeat(64),
          },
        ],
      }),
    );
    await expect(pullAll(configFor(corpus, files), DIR)).rejects.toMatchObject({
      kind: "state",
    });
    expect(files.removes).toEqual([]);
  });

  it("is byte-faithful for a file with no trailing newline and one with CRLF", async () => {
    const corpus = await newCorpus();
    const noNewline = "# Title\n\nno trailing newline";
    const crlf = "line one\r\nline two\r\n\r\nline three\r\n";
    await seed(corpus, "bare", noNewline);
    await seed(corpus, "windows", crlf);
    const files = memoryTree();

    await pullAll(configFor(corpus, files), DIR);

    expect(files.map.get(at("bare.md"))).toBe(noNewline);
    expect(files.map.get(at("windows.md"))).toBe(crlf);
    const cfg = configFor(corpus, files);
    files.writes.length = 0;
    const again = await pullAll(cfg, DIR);
    expect(again.unchanged).toHaveLength(2);
    expect(files.writes).toEqual([]);
  });

  it("serializes state deterministically: sorted, stable key order, trailing newline", async () => {
    const sha256 = "a".repeat(64);
    const corpus = { slug: "c", projectId: "p" };
    const forward = serializeState({
      version: STATE_VERSION,
      corpus,
      files: [
        { path: "a.md", slug: "a", docVersion: 1, sha256 },
        { path: "b/c.md", slug: "c", docVersion: 2, sha256 },
      ],
    });
    const reversed = serializeState({
      version: STATE_VERSION,
      corpus,
      files: [
        { sha256, docVersion: 2, slug: "c", path: "b/c.md" },
        { sha256, docVersion: 1, slug: "a", path: "a.md" },
      ],
    });
    expect(reversed).toBe(forward);
    expect(forward.endsWith("}\n")).toBe(true);
    expect(forward).toBe(
      `${JSON.stringify(
        {
          version: 1,
          corpus: { projectId: "p", slug: "c" },
          files: [
            { path: "a.md", slug: "a", docVersion: 1, sha256 },
            { path: "b/c.md", slug: "c", docVersion: 2, sha256 },
          ],
        },
        null,
        2,
      )}\n`,
    );
  });

  it("refuses to sync a different corpus into a directory that tracks another", async () => {
    const first = await newCorpus();
    await seed(first, "doc", "first\n");
    const second = await siblingCorpus(first);
    await seed(second, "other", "second\n");
    const files = memoryTree();
    await pullAll(configFor(first, files), DIR);

    const err = await pullAll(configFor(second, files), DIR).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(CliError);
    expect(err).toMatchObject({ kind: "state" });
    expect(files.map.has(at("other.md"))).toBe(false);
    expect(files.map.has(at("doc.md"))).toBe(true);
  });

  it("never lists another corpus's documents, even in the same project", async () => {
    const first = await newCorpus();
    await seed(first, "mine", "mine\n");
    const second = await siblingCorpus(first);
    await seed(second, "theirs", "theirs\n", "private");
    const files = memoryTree();

    await pullAll(configFor(first, files), DIR);

    expect([...files.map.keys()].sort()).toEqual([
      at(STATE_FILE),
      at("mine.md"),
    ]);
  });

  it("reports a transport failure as an http CliError and leaves the directory untouched", async () => {
    const corpus = await newCorpus();
    await seed(corpus, "doc", "x\n");
    const files = memoryTree();
    const failing: FetchLike = (input, init) =>
      new URL(input).pathname === "/api/v1/docs"
        ? SELF.fetch(input, init)
        : Promise.reject(new TypeError("connection refused"));

    const err = await pullAll(configFor(corpus, files, failing), DIR).catch(
      (e: unknown) => e,
    );

    expect(err).toMatchObject({ name: "CliError", kind: "http" });
    expect(files.writes).toEqual([]);
  });

  it("reports an auth failure as an http CliError with status 401", async () => {
    const corpus = await newCorpus();
    const files = memoryTree();
    const err = await pullAll(
      configFor({ ...corpus, token: "cck_not-a-real-key" }, files),
      DIR,
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "http", detail: { status: 401 } });
  });
});

describe("single-document pull/push inside a pull --all checkout", () => {
  it("push uses the state file's base version and updates it, with no sidecar", async () => {
    const corpus = await newCorpus();
    await seed(corpus, "runbook", "v1\n", "ops");
    const files = memoryTree();
    const cfg = configFor(corpus, files);
    await pullAll(cfg, DIR);

    files.map.set(at("ops/runbook.md"), "v2 from the checkout\n");
    const pushed = await push(cfg, "runbook", at("ops/runbook.md"));

    expect(pushed.docVersion).toBe(2);
    expect(files.map.has(sidecarPath(at("ops/runbook.md")))).toBe(false);
    expect(stateOf(files).files[0]).toMatchObject({
      docVersion: 2,
      sha256: await sha256Hex("v2 from the checkout\n"),
    });
    files.writes.length = 0;
    const report = await pullAll(cfg, DIR);
    expect(report.unchanged).toEqual(["ops/runbook.md"]);
    expect(report.keptLocal).toEqual([]);
    expect(files.writes).toEqual([]);
  });

  it("push still 409s when upstream moved past the state file's version", async () => {
    const corpus = await newCorpus();
    await seed(corpus, "runbook", "v1\n");
    const files = memoryTree();
    const cfg = configFor(corpus, files);
    await pullAll(cfg, DIR);
    await edit(corpus, "runbook", "upstream v2\n", 1);

    files.map.set(at("runbook.md"), "stale local\n");
    await expect(push(cfg, "runbook", at("runbook.md"))).rejects.toMatchObject({
      kind: "conflict",
      detail: { currentVersion: 2 },
    });
  });

  it("push refuses a tracked path owned by a different document", async () => {
    const corpus = await newCorpus();
    await seed(corpus, "runbook", "v1\n");
    const files = memoryTree();
    const cfg = configFor(corpus, files);
    await pullAll(cfg, DIR);
    await expect(
      push(cfg, "someone-else", at("runbook.md")),
    ).rejects.toMatchObject({ kind: "mismatch" });
  });

  it("single pull of a tracked file refreshes the state entry instead of writing a sidecar", async () => {
    const corpus = await newCorpus();
    await seed(corpus, "runbook", "v1\n");
    const files = memoryTree();
    const cfg = configFor(corpus, files);
    await pullAll(cfg, DIR);
    await edit(corpus, "runbook", "v2\n", 1);

    await pull(cfg, "runbook", at("runbook.md"));

    expect(files.map.has(sidecarPath(at("runbook.md")))).toBe(false);
    expect(stateOf(files).files[0]).toMatchObject({
      docVersion: 2,
      sha256: await sha256Hex("v2\n"),
    });
    const report: SyncReport = await pullAll(cfg, DIR);
    expect(report.unchanged).toEqual(["runbook.md"]);
  });

  it("a file outside any checkout keeps the sidecar workflow", async () => {
    const corpus = await newCorpus();
    await seed(corpus, "solo", "v1\n");
    const files = memoryTree();
    const cfg = configFor(corpus, files);

    await pull(cfg, "solo", "elsewhere/solo.md");

    expect(await readClientVersion(files, "elsewhere/solo.md")).toBe(1);
  });
});

describe("unsafePathProblem", () => {
  it.each([
    ["notes.md", undefined],
    ["a/b/c.md", undefined],
    ["..hidden/x.md", undefined],
    ["", "empty path"],
    ["/abs.md", "absolute path"],
    ["a//b.md", "empty, '.' or '..' segment"],
    ["a/./b.md", "empty, '.' or '..' segment"],
    ["../x.md", "empty, '.' or '..' segment"],
    ["trailing/", "empty, '.' or '..' segment"],
    ["a\\b.md", "backslash in path"],
    ["x/.GIT/config", "'.git' segment"],
    [".Corpus.json", "reserved for .corpus.json"],
  ])("%j -> %j", (path, problem) => {
    expect(unsafePathProblem(path)).toBe(problem);
  });
});
