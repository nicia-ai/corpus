import { describe, expect, it } from "vitest";

import { asCallerRef } from "../src/ids";

import { colSlug, docSlug, freshStore } from "./_helpers";

type Store = ReturnType<typeof freshStore>;

// Create-proposal lifecycle at the DO seam: an agent proposes a NEW
// document (suggestCreate — the MCP entry), a human applies or rejects it.
// Apply follows the import path's placement semantics (folders created as
// needed) and attaches the created document to the proposing connection's
// bound Collection as `reference` — never always-include.

const AGENT = asCallerRef("apikey:agent-a");
const BODY = "# Answer X\n\nthe answer body";

async function seedCollection(store: Store): Promise<void> {
  await store.saveDocument({
    slug: docSlug("doc-a"),
    markdown: "seed doc",
    clientVersion: 0,
    changedBy: "alice",
  });
  await store.createCollection({
    slug: colSlug("col-a"),
    name: "A",
    changedBy: "alice",
  });
  await store.attachDocument(colSlug("col-a"), docSlug("doc-a"), 1, "alice");
}

async function propose(
  store: Store,
  input: Readonly<{ slug?: string; path?: string }>,
): Promise<number> {
  const r = await store.suggestCreate(AGENT, {
    ...(input.slug !== undefined ? { slug: docSlug(input.slug) } : {}),
    ...(input.path !== undefined ? { path: input.path } : {}),
    proposedMarkdown: BODY,
    originCollectionSlug: colSlug("col-a"),
  });
  if (!r.ok) throw new Error(`propose failed: ${r.reason}`);
  return r.suggestionId;
}

describe("create-proposals (DO + D1 integration)", () => {
  it("apply creates the document at the proposed path and attaches it as reference", async () => {
    const store = freshStore("cprop");
    await seedCollection(store);
    const id = await propose(store, { path: "wiki/answer-x.md" });

    const applied = await store.applyCreateProposal({
      suggestionId: id,
      appliedBy: "paul",
    });
    expect(applied).toMatchObject({ ok: true, docVersion: 1 });

    const doc = await store.getDocument(docSlug("wiki-answer-x"));
    expect(doc?.markdown).toBe(BODY);

    const outline = await store.collectionOutline(colSlug("col-a"));
    if (!outline.found) throw new Error("outline missing");
    const member = outline.documents.find((d) => d.slug === "wiki-answer-x");
    expect(member?.path).toBe("wiki/answer-x.md");
    expect(member?.delivery).toBe("reference");

    // Terminal: the proposal left the open list.
    expect(await store.listCreateProposals()).toHaveLength(0);
  });

  it("apply survives a vanished origin Collection — document still created, no attach", async () => {
    const store = freshStore("cprop");
    await seedCollection(store);
    const r = await store.suggestCreate(AGENT, {
      slug: docSlug("orphaned"),
      proposedMarkdown: BODY,
      // A collection that no longer resolves at apply time.
      originCollectionSlug: colSlug("ghost-col"),
    });
    if (!r.ok) throw new Error("propose failed");

    const applied = await store.applyCreateProposal({
      suggestionId: r.suggestionId,
      appliedBy: "paul",
    });
    expect(applied).toMatchObject({ ok: true, docVersion: 1 });
    expect(await store.getDocument(docSlug("orphaned"))).toBeDefined();
  });

  it("creating a document through any path stales the open proposal for its slug", async () => {
    const store = freshStore("cprop");
    await seedCollection(store);
    const id = await propose(store, { slug: "late" });

    // A human (or the REST path) creates the document directly.
    await store.saveDocument({
      slug: docSlug("late"),
      markdown: "human got there first",
      clientVersion: 0,
      changedBy: "alice",
    });
    expect(await store.listCreateProposals()).toHaveLength(0);

    const applied = await store.applyCreateProposal({
      suggestionId: id,
      appliedBy: "paul",
    });
    expect(applied).toMatchObject({ ok: false, reason: "not-open" });
    // The direct creation won — the proposal never overwrote it.
    expect((await store.getDocument(docSlug("late")))?.markdown).toBe(
      "human got there first",
    );
  });

  it("apply marks the proposal stale when the path slot was taken by a different slug", async () => {
    const store = freshStore("cprop");
    await seedCollection(store);
    // Proposal claims slug "custom" but the path dir/file.md; an import then
    // occupies the same path under its own derived slug ("dir-file").
    const id = await propose(store, { slug: "custom" });
    const withPath = await store.suggestCreate(AGENT, {
      slug: docSlug("custom-2"),
      path: "dir/file.md",
      proposedMarkdown: BODY,
      originCollectionSlug: colSlug("col-a"),
    });
    if (!withPath.ok) throw new Error("propose failed");
    await store.importDocumentAtPath({
      path: "dir/file.md",
      markdown: "import got the slot",
      changedBy: "alice",
    });

    const applied = await store.applyCreateProposal({
      suggestionId: withPath.suggestionId,
      appliedBy: "paul",
    });
    expect(applied).toMatchObject({ ok: false, reason: "taken" });
    // The slug-only sibling proposal is untouched and still applies.
    const ok = await store.applyCreateProposal({
      suggestionId: id,
      appliedBy: "paul",
    });
    expect(ok).toMatchObject({ ok: true });
  });

  it("reject is terminal and creates nothing", async () => {
    const store = freshStore("cprop");
    await seedCollection(store);
    const id = await propose(store, { slug: "declined" });

    expect(
      await store.rejectSuggestion({ suggestionId: id, rejectedBy: "paul" }),
    ).toMatchObject({ ok: true });
    expect(await store.listCreateProposals()).toHaveLength(0);
    expect(await store.getDocument(docSlug("declined"))).toBeUndefined();

    const applied = await store.applyCreateProposal({
      suggestionId: id,
      appliedBy: "paul",
    });
    expect(applied).toMatchObject({ ok: false, reason: "not-open" });
  });

  it("the edit-apply path refuses a create-proposal and vice versa", async () => {
    const store = freshStore("cprop");
    await seedCollection(store);
    const id = await propose(store, { slug: "mismatched" });

    // Edit-apply on a create row: the target document doesn't exist.
    expect(
      await store.applySuggestion({ suggestionId: id, appliedBy: "paul" }),
    ).toMatchObject({ ok: false, reason: "missing" });

    // Create-apply on an edit row: refused as not-create.
    const edit = await store.createSuggestion({
      slug: docSlug("doc-a"),
      proposedMarkdown: "seed doc changed",
      clientVersion: 1,
      createdBy: "bob",
    });
    if (!edit.ok) throw new Error("edit suggestion failed");
    expect(
      await store.applyCreateProposal({
        suggestionId: edit.suggestionId,
        appliedBy: "paul",
      }),
    ).toMatchObject({ ok: false, reason: "not-create" });
  });

  it("edit-suggestion rails never list create-proposals for the same slug", async () => {
    const store = freshStore("cprop");
    await seedCollection(store);
    await propose(store, { slug: "shadow" });
    // The slug later becomes a real document (proposal → stale)…
    await store.saveDocument({
      slug: docSlug("shadow"),
      markdown: "now real",
      clientVersion: 0,
      changedBy: "alice",
    });
    // …and its review rail must not render the stale zero-hunk create row.
    expect(await store.listSuggestions(docSlug("shadow"))).toHaveLength(0);
  });
});
