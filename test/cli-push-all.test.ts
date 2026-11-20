import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { CliError, push } from "../cli/core";
import { formatPushReport, pushAll } from "../cli/push-all";
import { pullAll } from "../cli/sync";
import { sha256Hex, STATE_FILE } from "../cli/sync-state";
import { storeFor } from "../src/control/store-for";
import type { Grant } from "../src/grant";

import {
  type Corpus,
  configFor,
  DIR,
  edit,
  type MemoryTree,
  memoryTree,
  newCorpus,
  OWNER,
  seed,
} from "./_cli-fixtures";
import { docSlug } from "./_helpers";

// `corpus push --all`: what a checkout's local changes become, per grant.
// Every scenario starts from a real `pull --all` of a seeded corpus, edits
// the working tree, and runs the portable core against the test worker.

const at = (path: string): string => `${DIR}/${path}`;

type Checkout = Readonly<{ corpus: Corpus; tree: MemoryTree }>;

// A corpus of three documents, pulled into a fresh in-memory tree.
async function checkout(grant: Grant): Promise<Checkout> {
  const corpus = await newCorpus(grant);
  await seed(corpus, "readme", "# Readme\n\nstart here\n");
  await seed(corpus, "deploy", "# Deploy\n\nship it\n", "runbooks");
  await seed(corpus, "style", "# Style\n\nbe terse\n", "guides");
  const tree = memoryTree();
  await pullAll(configFor(corpus, tree), DIR);
  return { corpus, tree };
}

function write(tree: MemoryTree, path: string, text: string): void {
  tree.map.set(at(path), text);
}

function stateOf(tree: MemoryTree): {
  files: { path: string; slug: string; docVersion: number; sha256: string }[];
  proposals?: { path: string; baseVersion: number; proposalId: number }[];
} {
  return JSON.parse(tree.map.get(at(STATE_FILE)) ?? "null");
}

async function upstream(corpus: Corpus, slug: string) {
  return storeFor(env, corpus.projectId).getDocument(docSlug(slug));
}

async function listing(corpus: Corpus): Promise<readonly string[]> {
  const docs = await storeFor(env, corpus.projectId).listDocuments();
  return docs
    .filter((d) => d.corpusSlug === corpus.corpusSlug)
    .map((d) => d.slug)
    .sort();
}

// A pull straight after a push must have nothing to do.
async function expectPullIsUpToDate(c: Checkout): Promise<void> {
  const writesBefore = c.tree.writes.length;
  const removesBefore = c.tree.removes.length;
  const report = await pullAll(configFor(c.corpus, c.tree), DIR);
  expect(report).toMatchObject({
    added: [],
    updated: [],
    removed: [],
    keptLocal: [],
    conflicts: [],
  });
  expect(c.tree.writes.length).toBe(writesBefore);
  expect(c.tree.removes.length).toBe(removesBefore);
}

async function acceptAll(corpus: Corpus, slug: string): Promise<number> {
  const store = storeFor(env, corpus.projectId);
  const [suggestion] = await store.listSuggestions(docSlug(slug));
  if (suggestion === undefined) throw new Error("no proposal to accept");
  for (const hunk of suggestion.hunks) {
    await store.setHunkDecision({ hunkId: hunk.id, decision: "accepted" });
  }
  const r = await store.applySuggestion({
    suggestionId: suggestion.id,
    appliedBy: OWNER,
  });
  if (!r.ok) throw new Error(`apply failed: ${JSON.stringify(r)}`);
  return r.docVersion;
}

describe("push --all with edit access", () => {
  it("applies a modified file and leaves an immediate pull with nothing to do", async () => {
    const c = await checkout("edit");
    write(c.tree, "readme.md", "# Readme\n\nstart here, now with more\n");

    const report = await pushAll(configFor(c.corpus, c.tree), DIR);

    expect(report.applied).toEqual([{ path: "readme.md", action: "updated" }]);
    expect(report).toMatchObject({ conflicts: [], failed: [], unchanged: 2 });
    const doc = await upstream(c.corpus, "readme");
    expect(doc?.markdown).toBe("# Readme\n\nstart here, now with more\n");
    expect(doc?.docVersion).toBe(2);
    expect(
      stateOf(c.tree).files.find((f) => f.slug === "readme"),
    ).toMatchObject({
      docVersion: 2,
      sha256: await sha256Hex("# Readme\n\nstart here, now with more\n"),
    });
    await expectPullIsUpToDate(c);
  });

  it("creates a new markdown file in a nested folder", async () => {
    const c = await checkout("edit");
    write(c.tree, "ops/prod/oncall.md", "# On call\n\nrota\n");

    const report = await pushAll(configFor(c.corpus, c.tree), DIR);

    expect(report.applied).toEqual([
      { path: "ops/prod/oncall.md", action: "created" },
    ]);
    const entry = stateOf(c.tree).files.find(
      (f) => f.path === "ops/prod/oncall.md",
    );
    expect(entry).toMatchObject({ docVersion: 1 });
    const doc = await upstream(c.corpus, entry?.slug ?? "");
    expect(doc?.markdown).toBe("# On call\n\nrota\n");
    const outline = await storeFor(env, c.corpus.projectId).corpusOutline(
      c.corpus.corpusSlug,
    );
    expect(outline.found && outline.documents.map((d) => d.path)).toContain(
      "ops/prod/oncall.md",
    );
    await expectPullIsUpToDate(c);
  });

  it("archives a tracked file deleted locally, and the next pull does not restore it", async () => {
    const c = await checkout("edit");
    c.tree.map.delete(at("guides/style.md"));

    const report = await pushAll(configFor(c.corpus, c.tree), DIR);

    expect(report.applied).toEqual([
      { path: "guides/style.md", action: "archived" },
    ]);
    expect(await upstream(c.corpus, "style")).toBeUndefined();
    expect(stateOf(c.tree).files.map((f) => f.slug)).not.toContain("style");
    await expectPullIsUpToDate(c);
    expect(c.tree.map.has(at("guides/style.md"))).toBe(false);
  });

  it("moves a renamed file, keeping the document, its version and its history", async () => {
    const c = await checkout("edit");
    await edit(c.corpus, "deploy", "# Deploy\n\nship it carefully\n", 1);
    await pullAll(configFor(c.corpus, c.tree), DIR);
    const text = c.tree.map.get(at("runbooks/deploy.md")) ?? "";
    c.tree.map.delete(at("runbooks/deploy.md"));
    write(c.tree, "operations/release/ship.md", text);

    const report = await pushAll(configFor(c.corpus, c.tree), DIR);

    expect(report.applied).toEqual([
      {
        path: "operations/release/ship.md",
        action: "moved",
        from: "runbooks/deploy.md",
      },
    ]);
    expect(report.planned.map((a) => a.kind)).toEqual(["move"]);
    const store = storeFor(env, c.corpus.projectId);
    expect((await upstream(c.corpus, "deploy"))?.docVersion).toBe(2);
    expect((await store.verifyHistory(docSlug("deploy"))).ok).toBe(true);
    expect(await listing(c.corpus)).toEqual(["deploy", "readme", "style"]);
    expect(
      stateOf(c.tree).files.find((f) => f.slug === "deploy"),
    ).toMatchObject({
      path: "operations/release/ship.md",
      docVersion: 2,
    });
    await expectPullIsUpToDate(c);
  });

  it("treats a rename that also edits the file as an archive plus a new document", async () => {
    const c = await checkout("edit");
    c.tree.map.delete(at("readme.md"));
    write(c.tree, "intro.md", "# Intro\n\ncompletely different\n");

    const report = await pushAll(configFor(c.corpus, c.tree), DIR);

    expect(report.applied.map((a) => a.action).sort()).toEqual([
      "archived",
      "created",
    ]);
    expect(await upstream(c.corpus, "readme")).toBeUndefined();
    await expectPullIsUpToDate(c);
  });

  it("reports a file whose upstream moved as a conflict, leaves it, and still pushes the rest", async () => {
    const c = await checkout("edit");
    await edit(c.corpus, "readme", "# Readme\n\nsomeone else\n", 1);
    write(c.tree, "readme.md", "# Readme\n\nmine\n");
    write(c.tree, "guides/style.md", "# Style\n\nbe terser\n");

    const report = await pushAll(configFor(c.corpus, c.tree), DIR);

    expect(report.conflicts).toEqual([
      { path: "readme.md", slug: "readme", reason: "changed-upstream" },
    ]);
    expect(report.applied).toEqual([
      { path: "guides/style.md", action: "updated" },
    ]);
    expect(c.tree.map.get(at("readme.md"))).toBe("# Readme\n\nmine\n");
    expect((await upstream(c.corpus, "readme"))?.markdown).toBe(
      "# Readme\n\nsomeone else\n",
    );
    expect(formatPushReport(report, DIR).join("\n")).toContain(
      "changed upstream since your last pull",
    );
  });

  it("reports a local deletion of a file that changed upstream as a conflict", async () => {
    const c = await checkout("edit");
    await edit(c.corpus, "style", "# Style\n\nnew rules\n", 1);
    c.tree.map.delete(at("guides/style.md"));

    const report = await pushAll(configFor(c.corpus, c.tree), DIR);

    expect(report.conflicts).toMatchObject([
      { slug: "style", reason: "changed-upstream" },
    ]);
    expect(report.applied).toEqual([]);
    expect(await upstream(c.corpus, "style")).toBeDefined();
  });

  it("reports a new file whose path is already a document upstream", async () => {
    const c = await checkout("edit");
    await seed(c.corpus, "faq", "# FAQ\n");
    write(c.tree, "faq.md", "# My FAQ\n");

    const report = await pushAll(configFor(c.corpus, c.tree), DIR);

    expect(report.conflicts).toEqual([
      { path: "faq.md", slug: "faq", reason: "path-taken" },
    ]);
    expect((await upstream(c.corpus, "faq"))?.markdown).toBe("# FAQ\n");
  });

  it("with --dry-run prints the plan and sends nothing", async () => {
    const c = await checkout("edit");
    write(c.tree, "readme.md", "# Readme\n\nedited\n");
    write(c.tree, "new/page.md", "# Page\n");
    c.tree.map.delete(at("guides/style.md"));
    const stateBefore = c.tree.map.get(at(STATE_FILE));
    const writesBefore = c.tree.writes.length;

    const report = await pushAll(configFor(c.corpus, c.tree), DIR, {
      dryRun: true,
    });

    expect(report.dryRun).toBe(true);
    expect(report.planned.map((a) => `${a.kind} ${a.path}`).sort()).toEqual([
      "archive guides/style.md",
      "create new/page.md",
      "update readme.md",
    ]);
    expect(report.applied).toEqual([]);
    expect(formatPushReport(report, DIR)[0]).toBe(
      "dry run (edit access): nothing was sent. 3 change(s) planned in checkout",
    );
    expect((await upstream(c.corpus, "readme"))?.docVersion).toBe(1);
    expect(await upstream(c.corpus, "style")).toBeDefined();
    expect(await listing(c.corpus)).toEqual(["deploy", "readme", "style"]);
    expect(c.tree.map.get(at(STATE_FILE))).toBe(stateBefore);
    expect(c.tree.writes.length).toBe(writesBefore);
  });

  it("ignores non-markdown files (listing them once), the state file, sidecars and .git", async () => {
    const c = await checkout("edit");
    write(c.tree, "diagram.png", "not text");
    write(c.tree, "notes/todo.txt", "x");
    write(c.tree, ".git/config.md", "# git internals\n");
    write(c.tree, "readme.md.corpus.json", "{}");

    const report = await pushAll(configFor(c.corpus, c.tree), DIR);

    expect(report.applied).toEqual([]);
    expect(report.ignored).toEqual(["diagram.png", "notes/todo.txt"]);
    expect(
      formatPushReport(report, DIR).filter((l) => l.includes("diagram.png")),
    ).toHaveLength(1);
    expect(await listing(c.corpus)).toEqual(["deploy", "readme", "style"]);
  });

  it("refuses without a state file, telling the user to pull first", async () => {
    const corpus = await newCorpus("edit");
    const tree = memoryTree();
    write(tree, "stray.md", "# Stray\n");
    const error = await pushAll(configFor(corpus, tree), DIR).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).kind).toBe("state");
    expect((error as CliError).message).toContain("corpus pull --all");
    expect(await listing(corpus)).toEqual([]);
  });

  it("refuses an unsafe new path before sending anything, even with other changes ready", async () => {
    const c = await checkout("edit");
    write(c.tree, "readme.md", "# Readme\n\nready to go\n");
    write(c.tree, "bad\\name.md", "# Bad\n");

    const error = await pushAll(configFor(c.corpus, c.tree), DIR).catch(
      (e: unknown) => e,
    );

    expect((error as CliError).kind).toBe("unsafe-path");
    expect((await upstream(c.corpus, "readme"))?.docVersion).toBe(1);
  });

  it("never considers files outside the directory it was given", async () => {
    const c = await checkout("edit");
    c.tree.map.set("checkout-sibling/outside.md", "# Outside\n");
    c.tree.map.set("elsewhere/other.md", "# Other\n");

    const report = await pushAll(configFor(c.corpus, c.tree), DIR);

    expect(report.applied).toEqual([]);
    expect(await listing(c.corpus)).toEqual(["deploy", "readme", "style"]);
  });

  it("refuses a listing that points outside the directory", async () => {
    const c = await checkout("edit");
    write(c.tree, "../outside.md", "# Outside\n");

    const error = await pushAll(configFor(c.corpus, c.tree), DIR).catch(
      (e: unknown) => e,
    );

    expect((error as CliError).kind).toBe("unsafe-path");
    expect(await listing(c.corpus)).toEqual(["deploy", "readme", "style"]);
  });
});

describe("push --all with read access", () => {
  it("refuses before sending anything", async () => {
    const c = await checkout("read");
    write(c.tree, "readme.md", "# Readme\n\nedited\n");
    write(c.tree, "new.md", "# New\n");

    const error = await pushAll(configFor(c.corpus, c.tree), DIR).catch(
      (e: unknown) => e,
    );

    expect((error as CliError).kind).toBe("forbidden");
    expect((error as CliError).message).toContain("read access");
    const store = storeFor(env, c.corpus.projectId);
    expect((await upstream(c.corpus, "readme"))?.docVersion).toBe(1);
    expect(await store.listCreateProposals()).toEqual([]);
    expect(await store.listSuggestions(docSlug("readme"))).toEqual([]);
  });
});

describe("push --all with suggest access", () => {
  it("files an edit as a proposal and does not mark the file as synced", async () => {
    const c = await checkout("suggest");
    const stateBefore = stateOf(c.tree).files;
    write(c.tree, "readme.md", "# Readme\n\nproposed\n");

    const report = await pushAll(configFor(c.corpus, c.tree), DIR);

    expect(report.applied).toEqual([]);
    expect(report.proposed).toHaveLength(1);
    expect(report.proposed[0]).toMatchObject({
      path: "readme.md",
      kind: "edit",
    });
    expect(report.proposed[0]?.reviewUrl).toContain(
      `/p/${c.corpus.projectId}/documents/readme#proposal-`,
    );
    expect(formatPushReport(report, DIR).join("\n")).toContain(
      "These are proposals, not edits",
    );
    expect((await upstream(c.corpus, "readme"))?.docVersion).toBe(1);
    expect(stateOf(c.tree).files).toEqual(stateBefore);
    expect(stateOf(c.tree).proposals).toMatchObject([
      {
        path: "readme.md",
        baseVersion: 1,
        proposalId: report.proposed[0]?.proposalId,
      },
    ]);
  });

  it("does not file the same proposal twice, and a pull still keeps the local edit", async () => {
    const c = await checkout("suggest");
    write(c.tree, "readme.md", "# Readme\n\nproposed\n");
    await pushAll(configFor(c.corpus, c.tree), DIR);

    const again = await pushAll(configFor(c.corpus, c.tree), DIR);

    expect(again.proposed).toEqual([]);
    expect(again.skipped).toMatchObject([
      { path: "readme.md", reason: "already-proposed" },
    ]);
    const store = storeFor(env, c.corpus.projectId);
    expect(await store.listSuggestions(docSlug("readme"))).toHaveLength(1);

    const writesBefore = c.tree.writes.length;
    const pulled = await pullAll(configFor(c.corpus, c.tree), DIR);
    expect(pulled.keptLocal).toEqual(["readme.md"]);
    expect(pulled.conflicts).toEqual([]);
    expect(c.tree.writes.length).toBe(writesBefore);
    expect(c.tree.map.get(at("readme.md"))).toBe("# Readme\n\nproposed\n");
  });

  it("files a new file as a create proposal, and a pull leaves it alone", async () => {
    const c = await checkout("suggest");
    write(c.tree, "ops/new.md", "# New\n");

    const report = await pushAll(configFor(c.corpus, c.tree), DIR);

    expect(report.proposed).toMatchObject([
      { path: "ops/new.md", kind: "create" },
    ]);
    expect(stateOf(c.tree).files.map((f) => f.path)).not.toContain(
      "ops/new.md",
    );
    const again = await pushAll(configFor(c.corpus, c.tree), DIR);
    expect(again.proposed).toEqual([]);
    expect(again.skipped).toMatchObject([{ reason: "already-proposed" }]);
    const store = storeFor(env, c.corpus.projectId);
    expect(await store.listCreateProposals()).toHaveLength(1);
    const pulled = await pullAll(configFor(c.corpus, c.tree), DIR);
    expect(pulled).toMatchObject({ added: [], conflicts: [], removed: [] });
    expect(c.tree.map.get(at("ops/new.md"))).toBe("# New\n");
  });

  it("cannot propose a removal or a rename, and says so", async () => {
    const c = await checkout("suggest");
    c.tree.map.delete(at("guides/style.md"));
    const text = c.tree.map.get(at("runbooks/deploy.md")) ?? "";
    c.tree.map.delete(at("runbooks/deploy.md"));
    write(c.tree, "ops/deploy.md", text);

    const report = await pushAll(configFor(c.corpus, c.tree), DIR);

    expect(report.skipped.map((s) => `${s.reason} ${s.path}`).sort()).toEqual([
      "removal-needs-edit guides/style.md",
      "removal-needs-edit runbooks/deploy.md",
    ]);
    expect(report.proposed).toMatchObject([
      { path: "ops/deploy.md", kind: "create" },
    ]);
    expect(await upstream(c.corpus, "style")).toBeDefined();
    expect(await upstream(c.corpus, "deploy")).toBeDefined();
    expect(formatPushReport(report, DIR).join("\n")).toContain(
      "a removal cannot be proposed",
    );
  });

  it("round trip: once the proposal is applied upstream, pull updates the file cleanly", async () => {
    const c = await checkout("suggest");
    write(c.tree, "readme.md", "# Readme\n\nproposed\n");
    await pushAll(configFor(c.corpus, c.tree), DIR);
    const version = await acceptAll(c.corpus, "readme");
    expect(version).toBe(2);

    const writesBefore = c.tree.writes.filter(
      (w) => w !== at(STATE_FILE),
    ).length;
    const pulled = await pullAll(configFor(c.corpus, c.tree), DIR);

    expect(pulled.conflicts).toEqual([]);
    expect(pulled.keptLocal).toEqual([]);
    expect(pulled.unchanged).toContain("readme.md");
    expect(c.tree.writes.filter((w) => w !== at(STATE_FILE))).toHaveLength(
      writesBefore,
    );
    expect(
      stateOf(c.tree).files.find((f) => f.slug === "readme"),
    ).toMatchObject({
      docVersion: 2,
      sha256: await sha256Hex("# Readme\n\nproposed\n"),
    });
    expect(stateOf(c.tree).proposals).toBeUndefined();
    const next = await pushAll(configFor(c.corpus, c.tree), DIR);
    expect(next).toMatchObject({ proposed: [], skipped: [], conflicts: [] });
  });

  it("round trip: an applied create proposal is adopted by the next pull", async () => {
    const c = await checkout("suggest");
    write(c.tree, "ops/new.md", "# New\n");
    const report = await pushAll(configFor(c.corpus, c.tree), DIR);
    const store = storeFor(env, c.corpus.projectId);
    const applied = await store.applyCreateProposal({
      suggestionId: report.proposed[0]?.proposalId ?? 0,
      appliedBy: OWNER,
    });
    expect(applied).toMatchObject({ ok: true });

    const pulled = await pullAll(configFor(c.corpus, c.tree), DIR);

    expect(pulled.conflicts).toEqual([]);
    expect(stateOf(c.tree).files.map((f) => f.path)).toContain("ops/new.md");
    expect(stateOf(c.tree).proposals).toBeUndefined();
  });

  it("when a proposal is rejected the local edit remains, and pull --overwrite resets it", async () => {
    const c = await checkout("suggest");
    write(c.tree, "readme.md", "# Readme\n\nrejected idea\n");
    const report = await pushAll(configFor(c.corpus, c.tree), DIR);
    await storeFor(env, c.corpus.projectId).rejectSuggestion({
      suggestionId: report.proposed[0]?.proposalId ?? 0,
      rejectedBy: OWNER,
    });

    const kept = await pullAll(configFor(c.corpus, c.tree), DIR);
    expect(kept.keptLocal).toEqual(["readme.md"]);
    expect(kept.conflicts).toEqual([]);
    expect(c.tree.map.get(at("readme.md"))).toBe("# Readme\n\nrejected idea\n");

    await edit(c.corpus, "style", "# Style\n\nnew\n", 1);
    const reset = await pullAll(configFor(c.corpus, c.tree), DIR, {
      overwrite: true,
    });
    expect(reset.conflicts).toEqual([]);
    expect(c.tree.map.get(at("readme.md"))).toBe("# Readme\n\nstart here\n");
  });

  it("a partly accepted proposal leaves the pull with a conflict to resolve by hand", async () => {
    const c = await checkout("suggest");
    await edit(
      c.corpus,
      "readme",
      "# Readme\n\nstart here\n\nsecond paragraph\n\nthird paragraph\n",
      1,
    );
    await pullAll(configFor(c.corpus, c.tree), DIR);
    write(
      c.tree,
      "readme.md",
      "# Readme\n\nstart HERE\n\nsecond paragraph\n\nthird PARAGRAPH\n",
    );
    await pushAll(configFor(c.corpus, c.tree), DIR);
    const store = storeFor(env, c.corpus.projectId);
    const [suggestion] = await store.listSuggestions(docSlug("readme"));
    const [first, ...others] = suggestion?.hunks ?? [];
    await store.setHunkDecision({
      hunkId: first?.id ?? 0,
      decision: "accepted",
    });
    for (const hunk of others) {
      await store.setHunkDecision({ hunkId: hunk.id, decision: "rejected" });
    }
    await store.applySuggestion({
      suggestionId: suggestion?.id ?? 0,
      appliedBy: OWNER,
    });

    const pulled = await pullAll(configFor(c.corpus, c.tree), DIR);

    expect(pulled.conflicts).toMatchObject([
      { path: "readme.md", reason: "edited-locally" },
    ]);
  });
});

describe("single-document push", () => {
  it("creates a new document at a corpus path", async () => {
    const c = await checkout("edit");
    write(c.tree, "scratch/onboarding.md", "# Onboarding\n");

    const result = await push(
      configFor(c.corpus, c.tree),
      "onboarding",
      at("scratch/onboarding.md"),
      {
        docPath: "people/new-hires/onboarding.md",
      },
    );

    expect(result.docVersion).toBe(1);
    const outline = await storeFor(env, c.corpus.projectId).corpusOutline(
      c.corpus.corpusSlug,
    );
    expect(outline.found && outline.documents.map((d) => d.path)).toContain(
      "people/new-hires/onboarding.md",
    );
  });

  it("with suggest access files a proposal and records no version", async () => {
    const c = await checkout("suggest");
    write(c.tree, "scratch/guide.md", "# Guide\n");

    const result = await push(
      configFor(c.corpus, c.tree),
      "guide-page",
      at("scratch/guide.md"),
      {
        docPath: "guides/guide-page.md",
      },
    );

    expect(result.proposal).toMatchObject({ slug: "guide-page" });
    expect(result.docVersion).toBeUndefined();
    expect(c.tree.map.has(at("scratch/guide.md.corpus.json"))).toBe(false);
    expect(await upstream(c.corpus, "guide-page")).toBeUndefined();
  });

  it("with read access fails with what the key may do instead", async () => {
    const c = await checkout("read");
    write(c.tree, "readme.md", "# Readme\n\nedit\n");

    const error = await push(
      configFor(c.corpus, c.tree),
      "readme",
      at("readme.md"),
    ).catch((e: unknown) => e);

    expect((error as CliError).kind).toBe("forbidden");
    expect((error as CliError).message).toContain(
      "fetch one (GET /api/v1/docs/:slug)",
    );
  });
});
