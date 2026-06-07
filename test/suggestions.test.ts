import { describe, expect, it } from "vitest";

import { docSlug, freshStore } from "./_helpers";

type Store = ReturnType<typeof freshStore>;

const BASE = "alpha lead\n\nbeta middle\n\ngamma tail";

async function seed(store: Store, slug: ReturnType<typeof docSlug>) {
  await store.saveDocument({
    slug,
    markdown: BASE,
    clientVersion: 0,
    changedBy: "alice",
  });
}

describe("suggestions (DO + D1 integration)", () => {
  it("creates a suggestion, decomposes it into hunks, lists it", async () => {
    const store = freshStore("sug");
    const slug = docSlug("doc");
    await seed(store, slug);

    const r = await store.createSuggestion({
      slug,
      proposedMarkdown: `${BASE}\n\ndelta appended`,
      clientVersion: 1,
      createdBy: "bob",
    });
    expect(r).toMatchObject({ ok: true, hunkCount: 1 });

    const list = await store.listSuggestions(slug);
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe("open");
    expect(list[0]?.hunks).toHaveLength(1);
    expect(list[0]?.hunks[0]?.op).toBe("insert");
    expect(list[0]?.hunks[0]?.decision).toBe("pending");
  });

  it("accepts a hunk and applies it as a new version", async () => {
    const store = freshStore("sug");
    const slug = docSlug("doc");
    await seed(store, slug);
    const created = await store.createSuggestion({
      slug,
      proposedMarkdown: `${BASE}\n\ndelta appended`,
      clientVersion: 1,
      createdBy: "bob",
    });
    if (!created.ok) throw new Error("create failed");

    const hunk = (await store.listSuggestions(slug))[0]?.hunks[0];
    if (hunk === undefined) throw new Error("no hunk");
    await store.setHunkDecision({ hunkId: hunk.id, decision: "accepted" });

    const applied = await store.applySuggestion({
      suggestionId: created.suggestionId,
      appliedBy: "alice",
    });
    expect(applied).toMatchObject({ ok: true, docVersion: 2 });

    const doc = await store.getDocument(slug);
    expect(doc?.markdown).toContain("delta appended");
    expect((await store.listSuggestions(slug))[0]?.status).toBe("applied");
  });

  it("applies only the accepted hunks of a multi-hunk suggestion", async () => {
    const store = freshStore("sug");
    const slug = docSlug("doc");
    // block0 edited (a replace), block2 deleted → a mix of hunk ops.
    await store.saveDocument({
      slug,
      markdown: "the quick brown fox\n\ntwo middle\n\nthree end",
      clientVersion: 0,
      changedBy: "alice",
    });
    const created = await store.createSuggestion({
      slug,
      proposedMarkdown: "the quick brown cat\n\ntwo middle",
      clientVersion: 1,
      createdBy: "bob",
    });
    if (!created.ok) throw new Error("create failed");

    const hunks = (await store.listSuggestions(slug))[0]?.hunks ?? [];
    expect(hunks.length).toBeGreaterThan(1);
    // A genuinely partial accept needs both a delete and a non-delete hunk.
    expect(hunks.some((h) => h.op === "delete")).toBe(true);
    expect(hunks.some((h) => h.op !== "delete")).toBe(true);
    // Accept ONLY the deletion(s); reject the block0 edit.
    for (const h of hunks) {
      await store.setHunkDecision({
        hunkId: h.id,
        decision: h.op === "delete" ? "accepted" : "rejected",
      });
    }

    expect(
      await store.applySuggestion({
        suggestionId: created.suggestionId,
        appliedBy: "alice",
      }),
    ).toMatchObject({ ok: true, docVersion: 2 });

    const doc = await store.getDocument(slug);
    expect(doc?.markdown).toContain("the quick brown fox"); // edit rejected
    expect(doc?.markdown).not.toContain("brown cat");
    expect(doc?.markdown).not.toContain("three end"); // deletion accepted
  });

  it("refuses to apply when no hunk was accepted", async () => {
    const store = freshStore("sug");
    const slug = docSlug("doc");
    await seed(store, slug);
    const created = await store.createSuggestion({
      slug,
      proposedMarkdown: `${BASE}\n\ndelta appended`,
      clientVersion: 1,
      createdBy: "bob",
    });
    if (!created.ok) throw new Error("create failed");
    const r = await store.applySuggestion({
      suggestionId: created.suggestionId,
      appliedBy: "alice",
    });
    expect(r).toMatchObject({ ok: false, reason: "nothing-accepted" });
  });

  it("goes stale when the document moved off the suggestion's base", async () => {
    const store = freshStore("sug");
    const slug = docSlug("doc");
    await seed(store, slug);
    const created = await store.createSuggestion({
      slug,
      proposedMarkdown: `${BASE}\n\ndelta appended`,
      clientVersion: 1,
      createdBy: "bob",
    });
    if (!created.ok) throw new Error("create failed");
    const hunk = (await store.listSuggestions(slug))[0]?.hunks[0];
    if (hunk === undefined) throw new Error("no hunk");
    await store.setHunkDecision({ hunkId: hunk.id, decision: "accepted" });

    // someone edits the doc → head moves to v2
    await store.saveDocument({
      slug,
      markdown: `${BASE}\n\nunrelated edit`,
      clientVersion: 1,
      changedBy: "carol",
    });

    const r = await store.applySuggestion({
      suggestionId: created.suggestionId,
      appliedBy: "alice",
    });
    expect(r).toMatchObject({ ok: false, reason: "stale", currentVersion: 2 });
    expect((await store.listSuggestions(slug))[0]?.status).toBe("stale");
  });

  it("rejects a suggestion", async () => {
    const store = freshStore("sug");
    const slug = docSlug("doc");
    await seed(store, slug);
    const created = await store.createSuggestion({
      slug,
      proposedMarkdown: `${BASE}\n\ndelta appended`,
      clientVersion: 1,
      createdBy: "bob",
    });
    if (!created.ok) throw new Error("create failed");
    expect(
      await store.rejectSuggestion({
        suggestionId: created.suggestionId,
        rejectedBy: "alice",
      }),
    ).toEqual({ ok: true });
    expect((await store.listSuggestions(slug))[0]?.status).toBe("rejected");
  });

  // Once a suggestion leaves `open` (applied / rejected / stale) its
  // outcome and hunk decisions are settled review history. A late
  // reject or hunk flip must be a no-op (ok:false), never silently
  // rewrite the record. Regression for terminal-state mutability.
  describe("terminal states are immutable", () => {
    async function openSuggestion(store: Store) {
      const slug = docSlug("doc");
      await seed(store, slug);
      const created = await store.createSuggestion({
        slug,
        proposedMarkdown: `${BASE}\n\ndelta appended`,
        clientVersion: 1,
        createdBy: "bob",
      });
      if (!created.ok) throw new Error("create failed");
      const hunk = (await store.listSuggestions(slug))[0]?.hunks[0];
      if (hunk === undefined) throw new Error("no hunk");
      return { slug, suggestionId: created.suggestionId, hunkId: hunk.id };
    }

    it("won't reject or re-decide an applied suggestion", async () => {
      const store = freshStore("sug");
      const { slug, suggestionId, hunkId } = await openSuggestion(store);
      await store.setHunkDecision({ hunkId, decision: "accepted" });
      const applied = await store.applySuggestion({
        suggestionId,
        appliedBy: "alice",
      });
      expect(applied).toMatchObject({ ok: true, docVersion: 2 });

      expect(
        await store.rejectSuggestion({ suggestionId, rejectedBy: "carol" }),
      ).toEqual({ ok: false });
      expect(
        await store.setHunkDecision({ hunkId, decision: "rejected" }),
      ).toEqual({ ok: false });

      const s = (await store.listSuggestions(slug))[0];
      expect(s?.status).toBe("applied");
      expect(s?.hunks[0]?.decision).toBe("accepted");
    });

    it("won't re-reject or re-decide a rejected suggestion", async () => {
      const store = freshStore("sug");
      const { slug, suggestionId, hunkId } = await openSuggestion(store);
      expect(
        await store.rejectSuggestion({ suggestionId, rejectedBy: "alice" }),
      ).toEqual({ ok: true });

      expect(
        await store.rejectSuggestion({ suggestionId, rejectedBy: "carol" }),
      ).toEqual({ ok: false });
      expect(
        await store.setHunkDecision({ hunkId, decision: "accepted" }),
      ).toEqual({ ok: false });
      expect((await store.listSuggestions(slug))[0]?.status).toBe("rejected");
    });

    it("won't re-decide a hunk on a stale suggestion", async () => {
      const store = freshStore("sug");
      const { slug, suggestionId, hunkId } = await openSuggestion(store);
      await store.setHunkDecision({ hunkId, decision: "accepted" });
      // Head moves off the base → applying marks the suggestion stale.
      await store.saveDocument({
        slug,
        markdown: `${BASE}\n\nunrelated edit`,
        clientVersion: 1,
        changedBy: "carol",
      });
      await store.applySuggestion({ suggestionId, appliedBy: "alice" });
      expect((await store.listSuggestions(slug))[0]?.status).toBe("stale");

      expect(
        await store.setHunkDecision({ hunkId, decision: "rejected" }),
      ).toEqual({ ok: false });
    });

    it("ok:false for a hunk that does not exist", async () => {
      const store = freshStore("sug");
      expect(
        await store.setHunkDecision({ hunkId: 999999, decision: "accepted" }),
      ).toEqual({ ok: false });
    });

    it("won't apply a rejected suggestion", async () => {
      const store = freshStore("sug");
      const { suggestionId } = await openSuggestion(store);
      await store.rejectSuggestion({ suggestionId, rejectedBy: "alice" });
      expect(
        await store.applySuggestion({ suggestionId, appliedBy: "carol" }),
      ).toMatchObject({ ok: false, reason: "not-open" });
    });

    it("won't re-apply an already-applied suggestion", async () => {
      const store = freshStore("sug");
      const { suggestionId, hunkId } = await openSuggestion(store);
      await store.setHunkDecision({ hunkId, decision: "accepted" });
      await store.applySuggestion({ suggestionId, appliedBy: "alice" });
      expect(
        await store.applySuggestion({ suggestionId, appliedBy: "alice" }),
      ).toMatchObject({ ok: false, reason: "not-open" });
    });
  });

  it("returns no-change when the proposal equals the document", async () => {
    const store = freshStore("sug");
    const slug = docSlug("doc");
    await seed(store, slug);
    expect(
      await store.createSuggestion({
        slug,
        proposedMarkdown: BASE,
        clientVersion: 1,
        createdBy: "bob",
      }),
    ).toMatchObject({ ok: false, reason: "no-change" });
  });

  it("409s a proposal authored against a stale version", async () => {
    const store = freshStore("sug");
    const slug = docSlug("doc");
    await seed(store, slug);
    await store.saveDocument({
      slug,
      markdown: `${BASE}\n\nmoved on`,
      clientVersion: 1,
      changedBy: "carol",
    });
    expect(
      await store.createSuggestion({
        slug,
        proposedMarkdown: `${BASE}\n\ndelta`,
        clientVersion: 1,
        createdBy: "bob",
      }),
    ).toMatchObject({ ok: false, reason: "conflict", currentVersion: 2 });
  });

  it("records the agent origin on the applied version's change event", async () => {
    const store = freshStore("sug");
    const slug = docSlug("doc");
    await seed(store, slug);
    const created = await store.createSuggestion({
      slug,
      proposedMarkdown: `${BASE}\n\ndelta appended`,
      clientVersion: 1,
      createdBy: "apikey:agent-x",
      channel: "mcp",
    });
    if (!created.ok) throw new Error("create failed");
    const hunk = (await store.listSuggestions(slug))[0]?.hunks[0];
    if (hunk === undefined) throw new Error("no hunk");
    await store.setHunkDecision({ hunkId: hunk.id, decision: "accepted" });
    expect(
      await store.applySuggestion({
        suggestionId: created.suggestionId,
        appliedBy: "alice",
      }),
    ).toMatchObject({ ok: true });

    const [latest] = await store.recentChanges(1);
    expect(latest?.eventType).toBe("document.updated");
    // changedBy is the human approver; appliedFrom is the durable link back
    // to the suggestion (and the agent that proposed it).
    expect(latest?.changedBy).toBe("alice");
    const after = JSON.parse(latest?.afterJson ?? "{}") as {
      appliedFrom?: { by: string; channel: string; suggestionId: number };
    };
    expect(after.appliedFrom).toMatchObject({
      by: "apikey:agent-x",
      channel: "mcp",
      suggestionId: created.suggestionId,
    });
  });
});
