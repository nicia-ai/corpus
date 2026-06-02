import { describe, expect, it } from "vitest";

import { docSlug, freshStore } from "./_helpers";

// Each test gets a fresh project id → a clean ProjectStore instance.
const freshProject = () => freshStore("save");

describe("save path — atomic enlisted transaction (TypeGraph 0.26 do-sqlite)", () => {
  it("creates then updates, version ledger tracks every write", async () => {
    const store = freshProject();

    const c = await store.saveDocument({
      slug: docSlug("refund-policy"),
      markdown: "# Refund Policy\n14 day window.",
      clientVersion: 0,
      changedBy: "alice",
    });
    expect(c).toEqual({ ok: true, docVersion: 1 });

    const u = await store.saveDocument({
      slug: docSlug("refund-policy"),
      markdown: "# Refund Policy\n30 day window.",
      clientVersion: 1,
      changedBy: "bob",
    });
    expect(u).toEqual({ ok: true, docVersion: 2 });

    const head = await store.getDocument(docSlug("refund-policy"));
    expect(head?.markdown).toContain("30 day window");
    expect(head?.docVersion).toBe(2);
    expect(await store.versionCount(docSlug("refund-policy"))).toBe(2);
  });

  it("rejects a stale save with 409 and writes nothing", async () => {
    const store = freshProject();
    await store.saveDocument({
      slug: docSlug("icp"),
      markdown: "v1",
      clientVersion: 0,
      changedBy: "alice",
    });
    await store.saveDocument({
      slug: docSlug("icp"),
      markdown: "v2",
      clientVersion: 1,
      changedBy: "alice",
    });

    const stale = await store.saveDocument({
      slug: docSlug("icp"),
      markdown: "v3 from a stale tab",
      clientVersion: 0, // head is 2
      changedBy: "carol",
    });
    expect(stale).toEqual({ ok: false, conflict: true, currentVersion: 2 });

    const head = await store.getDocument(docSlug("icp"));
    expect(head?.markdown).toBe("v2");
    expect(head?.docVersion).toBe(2);
    expect(await store.versionCount(docSlug("icp"))).toBe(2); // no partial write
  });

  it("rolls back the TypeGraph node update AND both ledger inserts together (T0 proof)", async () => {
    const store = freshProject();

    const r = await store.saveDocument({
      slug: docSlug("messaging"),
      markdown: "# Messaging",
      clientVersion: 0,
      changedBy: "alice",
      __failAfterWrites: true,
    });
    expect(r).toEqual({ ok: false, rolledBack: true });

    // Document head node create rolled back:
    expect(await store.getDocument(docSlug("messaging"))).toBeUndefined();
    // DocumentVersion node + blob + change event rolled back:
    expect(await store.versionCount(docSlug("messaging"))).toBe(0);
  });

  it("same-entity contention: concurrent N+1 → exactly one wins, one 409", async () => {
    const store = freshProject();
    await store.saveDocument({
      slug: docSlug("pricing"),
      markdown: "base",
      clientVersion: 0,
      changedBy: "alice",
    });

    const [a, b] = await Promise.all([
      store.saveDocument({
        slug: docSlug("pricing"),
        markdown: "edit A",
        clientVersion: 1,
        changedBy: "alice",
      }),
      store.saveDocument({
        slug: docSlug("pricing"),
        markdown: "edit B",
        clientVersion: 1,
        changedBy: "bob",
      }),
    ]);

    const wins = [a, b].filter((r) => r.ok).length;
    const conflicts = [a, b].filter((r) => !r.ok).length;
    expect(wins).toBe(1);
    expect(conflicts).toBe(1);
    // base + exactly one winner; the loser's whole tx aborted.
    expect(await store.versionCount(docSlug("pricing"))).toBe(2);
    expect((await store.getDocument(docSlug("pricing")))?.docVersion).toBe(2);
  });
});
