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
  it("projects proposal messages to the human UI and caller-scoped MCP result", async () => {
    const store = freshStore("cprop");
    await seedCollection(store);
    const id = await propose(store, { slug: "conversation" });

    await store.addSuggestionMessage({
      suggestionId: id,
      body: "Clarify the opening paragraph.",
      createdBy: "reviewer-user-id",
      channel: "web",
    });
    expect(await store.listCreateProposals()).toMatchObject([
      {
        id,
        messages: [
          {
            body: "Clarify the opening paragraph.",
            createdBy: "reviewer-user-id",
            channel: "web",
          },
        ],
      },
    ]);

    expect(
      await store.replyToProposal(AGENT, id, "I will tighten it."),
    ).toMatchObject({ ok: true });
    const result = await store.proposalResult(AGENT, id);
    expect(result).toMatchObject({
      found: true,
      messages: [
        { role: "reviewer", channel: "web" },
        { role: "proposer", channel: "mcp" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("reviewer-user-id");

    await store.rejectSuggestion({ suggestionId: id, rejectedBy: "paul" });
    expect(await store.replyToProposal(AGENT, id, "too late")).toEqual({
      ok: false,
      reason: "not-open",
    });
    const settled = await store.proposalResult(AGENT, id);
    expect(JSON.stringify(settled)).not.toContain("too late");
  });

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

  it("propose rejects a path whose slot an existing document occupies", async () => {
    const store = freshStore("cprop");
    await seedCollection(store);
    await store.importDocumentAtPath({
      path: "wiki/notes.md",
      markdown: "# occupied",
      changedBy: "alice",
    });
    // Same path → the slot is taken project-wide, even though the derived
    // slug would steer around the collision (it must fail at propose time,
    // not linger as a proposal that can only go stale at apply).
    const taken = await store.suggestCreate(AGENT, {
      path: "wiki/notes.md",
      proposedMarkdown: BODY,
      originCollectionSlug: colSlug("col-a"),
    });
    expect(taken).toEqual({ ok: false, reason: "taken" });
    // Root-level slots are checked the same way…
    await store.importDocumentAtPath({
      path: "readme.md",
      markdown: "# root",
      changedBy: "alice",
    });
    const rootTaken = await store.suggestCreate(AGENT, {
      path: "readme.md",
      proposedMarkdown: BODY,
      originCollectionSlug: colSlug("col-a"),
    });
    expect(rootTaken).toEqual({ ok: false, reason: "taken" });
    // …and a missing folder chain leaves the slot free.
    const fresh = await store.suggestCreate(AGENT, {
      path: "brand-new/notes.md",
      proposedMarkdown: BODY,
      originCollectionSlug: colSlug("col-a"),
    });
    expect(fresh.ok).toBe(true);
  });

  it("propose rejects a path whose slot an existing FOLDER occupies", async () => {
    const store = freshStore("cprop");
    await seedCollection(store);
    // Importing wiki/notes.md/inner.md creates a folder NAMED "notes.md" —
    // the cross-type namespace: a document may not share a sibling
    // folder's name.
    await store.importDocumentAtPath({
      path: "wiki/notes.md/inner.md",
      markdown: "# inner",
      changedBy: "alice",
    });
    const taken = await store.suggestCreate(AGENT, {
      path: "wiki/notes.md",
      proposedMarkdown: BODY,
      originCollectionSlug: colSlug("col-a"),
    });
    expect(taken).toEqual({ ok: false, reason: "taken" });
  });

  it("a folder claiming the slot after propose makes apply return taken with NO writes", async () => {
    const store = freshStore("cprop");
    await seedCollection(store);
    const id = await propose(store, { path: "wiki/report.md" });
    // The race: a folder named "report.md" lands under wiki/ before apply.
    await store.importDocumentAtPath({
      path: "wiki/report.md/inner.md",
      markdown: "# inner",
      changedBy: "alice",
    });

    const applied = await store.applyCreateProposal({
      suggestionId: id,
      appliedBy: "paul",
    });
    expect(applied).toEqual({ ok: false, reason: "taken" });
    // Nothing was created: no document (hence no version and no blob
    // reference), and the proposal left the open list as stale.
    expect(await store.getDocument(docSlug("wiki-report"))).toBeUndefined();
    expect((await store.listDocumentRefs()).map((r) => r.slug)).not.toContain(
      "wiki-report",
    );
    expect(await store.listCreateProposals()).toHaveLength(0);
  });

  it("apply succeeds for a folder-placed path when a root document shares the filename", async () => {
    const store = freshStore("cprop");
    await seedCollection(store);
    // Root document holding readme.md — a folder-placed readme.md is NOT
    // a collision (filename uniqueness is per-folder; regression for the
    // folder-scoped save-path check).
    await store.importDocumentAtPath({
      path: "readme.md",
      markdown: "# root readme",
      changedBy: "alice",
    });
    const id = await propose(store, { path: "wiki/readme.md" });

    const applied = await store.applyCreateProposal({
      suggestionId: id,
      appliedBy: "paul",
    });
    expect(applied).toMatchObject({ ok: true, docVersion: 1 });
    const doc = await store.getDocument(docSlug("wiki-readme"));
    expect(doc?.markdown).toBe(BODY);
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
