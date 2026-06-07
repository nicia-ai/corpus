import { describe, expect, it } from "vitest";

import type { CreateCommentResult } from "../src/project-store/commands/comments";

import { docSlug, freshStore } from "./_helpers";

type Store = ReturnType<typeof freshStore>;

const THREE_PARAS = "alpha lead\n\nbeta middle here\n\ngamma tail";

// Anchor a comment to the block containing `needle`, selecting `selection`
// within it. clientVersion is read from the same call the client renders,
// mirroring the real flow.
async function commentOn(
  store: Store,
  slug: ReturnType<typeof docSlug>,
  needle: string,
  selection: string,
): Promise<CreateCommentResult> {
  const blocks = await store.getDocumentBlocks(slug);
  if (!blocks.found) throw new Error("document not found");
  const index = blocks.blocks.findIndex((b) => b.text.includes(needle));
  const target = blocks.blocks[index];
  if (target === undefined) throw new Error(`no block contains '${needle}'`);
  const start = target.text.indexOf(selection);
  return store.createComment({
    slug,
    blockIndex: index,
    start,
    end: start + selection.length,
    body: `re: ${selection}`,
    clientVersion: blocks.docVersion,
    createdBy: "alice",
  });
}

describe("comment anchors (DO + D1 integration)", () => {
  it("relocates an anchor when its block is edited around the quote", async () => {
    const store = freshStore("reloc");
    const slug = docSlug("notes");
    expect(
      await store.saveDocument({
        slug,
        markdown: THREE_PARAS,
        clientVersion: 0,
        changedBy: "alice",
      }),
    ).toMatchObject({ ok: true, docVersion: 1 });

    const created = await commentOn(store, slug, "beta middle here", "middle");
    expect(created.ok).toBe(true);

    // Prepend "PREFIX " to the anchored block — 'middle' shifts 5 → 12.
    expect(
      await store.saveDocument({
        slug,
        markdown: "alpha lead\n\nPREFIX beta middle here\n\ngamma tail",
        clientVersion: 1,
        changedBy: "bob",
      }),
    ).toMatchObject({ ok: true, docVersion: 2 });

    const threads = await store.listComments(slug);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.status).toBe("open");
    expect(threads[0]?.quote.exact).toBe("middle");
    expect(threads[0]?.anchorStart).toBe(12);
    expect(threads[0]?.anchorEnd).toBe(18);
  });

  it("orphans an anchor when its quoted text is gone", async () => {
    const store = freshStore("orphan");
    const slug = docSlug("notes");
    await store.saveDocument({
      slug,
      markdown: THREE_PARAS,
      clientVersion: 0,
      changedBy: "alice",
    });
    expect(
      (await commentOn(store, slug, "beta middle here", "middle")).ok,
    ).toBe(true);

    // Replace the anchored block entirely — 'middle' exists nowhere.
    await store.saveDocument({
      slug,
      markdown: "alpha lead\n\ncompletely unrelated replacement\n\ngamma tail",
      clientVersion: 1,
      changedBy: "bob",
    });

    const threads = await store.listComments(slug);
    expect(threads[0]?.status).toBe("orphaned");
    expect(threads[0]?.quote.exact).toBe("middle"); // quote preserved for re-anchor
  });

  it("follows a block that moves to a new position", async () => {
    const store = freshStore("move");
    const slug = docSlug("notes");
    await store.saveDocument({
      slug,
      markdown: "alpha lead\n\nbeta middle\n\ngamma tail",
      clientVersion: 0,
      changedBy: "alice",
    });
    expect((await commentOn(store, slug, "beta middle", "middle")).ok).toBe(
      true,
    );

    // Drag "beta middle" to the top — content unchanged.
    await store.saveDocument({
      slug,
      markdown: "beta middle\n\nalpha lead\n\ngamma tail",
      clientVersion: 1,
      changedBy: "bob",
    });

    const threads = await store.listComments(slug);
    expect(threads[0]?.status).toBe("open");
    expect(threads[0]?.anchorStart).toBe(5); // 'middle' in "beta middle"
  });

  it("exposes current block ids for anchored comment highlighting", async () => {
    const store = freshStore("block-ids");
    const slug = docSlug("notes");
    await store.saveDocument({
      slug,
      markdown: "same text\n\nsame text",
      clientVersion: 0,
      changedBy: "alice",
    });
    expect((await commentOn(store, slug, "same text", "same")).ok).toBe(true);

    const threads = await store.listComments(slug);
    const blocks = await store.getDocumentBlocks(slug);
    if (!blocks.found) throw new Error("doc not found");
    expect(blocks.blocks[0]?.id).toBe(threads[0]?.anchorBlockId);
  });

  it("supports replies and resolution, and a resolved thread is left alone", async () => {
    const store = freshStore("thread");
    const slug = docSlug("notes");
    await store.saveDocument({
      slug,
      markdown: "alpha lead\n\nbeta middle\n\ngamma tail",
      clientVersion: 0,
      changedBy: "alice",
    });
    const created = await commentOn(store, slug, "beta middle", "middle");
    if (!created.ok) throw new Error("createComment failed");

    await store.addComment({
      threadId: created.threadId,
      body: "good point",
      createdBy: "bob",
    });
    let threads = await store.listComments(slug);
    expect(threads[0]?.comments).toHaveLength(2);

    expect(
      await store.resolveCommentThread({
        threadId: created.threadId,
        resolvedBy: "bob",
      }),
    ).toEqual({ ok: true });

    // A later save must not touch the resolved thread (lazy gate: no open
    // threads ⇒ no rebase work at all).
    await store.saveDocument({
      slug,
      markdown: "beta middle\n\nalpha lead\n\ngamma tail",
      clientVersion: 1,
      changedBy: "carol",
    });
    threads = await store.listComments(slug);
    expect(threads[0]?.status).toBe("resolved");
    expect(threads[0]?.resolvedBy).toBe("bob");
  });

  it("returns missing when the document does not exist", async () => {
    const store = freshStore("nodoc");
    const r = await store.createComment({
      slug: docSlug("ghost"),
      blockIndex: 0,
      start: 0,
      end: 1,
      body: "on nothing",
      clientVersion: 0,
      createdBy: "alice",
    });
    expect(r).toMatchObject({ ok: false, reason: "missing" });
  });

  it("returns bad-block when the block index is out of range", async () => {
    const store = freshStore("badblock");
    const slug = docSlug("notes");
    await store.saveDocument({
      slug,
      markdown: THREE_PARAS,
      clientVersion: 0,
      changedBy: "alice",
    });
    const blocks = await store.getDocumentBlocks(slug);
    if (!blocks.found) throw new Error("doc not found");
    const r = await store.createComment({
      slug,
      blockIndex: blocks.blocks.length, // one past the last block
      start: 0,
      end: 1,
      body: "anchored to nothing",
      clientVersion: blocks.docVersion,
      createdBy: "alice",
    });
    expect(r).toMatchObject({ ok: false, reason: "bad-block" });
  });

  it("409s when the head moved under the selection", async () => {
    const store = freshStore("conflict");
    const slug = docSlug("notes");
    await store.saveDocument({
      slug,
      markdown: THREE_PARAS,
      clientVersion: 0,
      changedBy: "alice",
    });
    const blocks = await store.getDocumentBlocks(slug); // docVersion 1
    if (!blocks.found) throw new Error("doc not found");

    // Someone else saves; head is now 2.
    await store.saveDocument({
      slug,
      markdown: "alpha lead\n\nbeta middle here edited\n\ngamma tail",
      clientVersion: 1,
      changedBy: "bob",
    });

    const r = await store.createComment({
      slug,
      blockIndex: 1,
      start: 0,
      end: 4,
      body: "stale",
      clientVersion: blocks.docVersion,
      createdBy: "alice",
    });
    expect(r).toMatchObject({
      ok: false,
      reason: "conflict",
      currentVersion: 2,
    });
  });
});
