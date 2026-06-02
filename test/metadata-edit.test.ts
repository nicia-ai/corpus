import { describe, expect, it } from "vitest";

import { colSlug, docSlug, freshStore } from "./_helpers";

const SOURCE = { organization: "o", project: "p" } as const;

// Metadata edits (document rename, collection name/description) are
// head-pointer-only: they must NOT touch the content-addressed version
// chain or the immutable CollectionVersion membership snapshots.
describe("renameDocument — title-only, no version-chain mutation", () => {
  it("changes the head title without bumping docVersion or the chain", async () => {
    const w = freshStore("rename");
    const slug = docSlug("brand-voice");
    await w.saveDocument({
      slug,
      markdown: "# Brand Voice\nv1",
      clientVersion: 0,
      changedBy: "alice",
    });
    await w.saveDocument({
      slug,
      markdown: "# Brand Voice\nv2",
      clientVersion: 1,
      changedBy: "bob",
    });
    const before = await w.getDocument(slug);
    expect(before?.docVersion).toBe(2);
    expect(await w.versionCount(slug)).toBe(2);

    expect(
      (
        await w.renameDocument({
          slug,
          title: "Voice & Tone",
          changedBy: "carol",
        })
      ).ok,
    ).toBe(true);

    const after = await w.getDocument(slug);
    expect(after?.title).toBe("Voice & Tone");
    // Content + version chain untouched.
    expect(after?.docVersion).toBe(2);
    expect(after?.markdown).toBe("# Brand Voice\nv2");
    expect(await w.versionCount(slug)).toBe(2);
    expect((await w.documentHistory(slug)).map((h) => h.docVersion)).toEqual([
      2, 1,
    ]);
    expect(await w.verifyHistory(slug)).toEqual({ ok: true });
  });

  it("emits a document.renamed change event", async () => {
    const w = freshStore("rename");
    const slug = docSlug("policy");
    await w.saveDocument({
      slug,
      markdown: "# Policy",
      clientVersion: 0,
      changedBy: "u",
    });
    await w.renameDocument({ slug, title: "Refund Policy", changedBy: "dave" });
    const [latest] = await w.recentChanges(1);
    expect(latest).toMatchObject({
      eventType: "document.renamed",
      documentSlug: "policy",
      changedBy: "dave",
    });
  });

  it("an unchanged title is an idempotent no-op (no event)", async () => {
    const w = freshStore("rename");
    const slug = docSlug("icp");
    await w.saveDocument({
      slug,
      markdown: "# ICP",
      clientVersion: 0,
      changedBy: "u",
    });
    await w.renameDocument({ slug, title: "Ideal Customer", changedBy: "u" });
    const evtId = await w.lastEventId();
    expect(
      (
        await w.renameDocument({
          slug,
          title: "Ideal Customer",
          changedBy: "u",
        })
      ).ok,
    ).toBe(true);
    expect(await w.lastEventId()).toBe(evtId);
  });

  it("renaming a missing document is ok:false", async () => {
    const w = freshStore("rename");
    expect(
      (
        await w.renameDocument({
          slug: docSlug("ghost"),
          title: "X",
          changedBy: "u",
        })
      ).ok,
    ).toBe(false);
  });
});

describe("updateCollection — name/description, no CollectionVersion cut", () => {
  it("edits name/description, leaves slug + membership snapshot intact", async () => {
    const w = freshStore("coledit");
    await w.saveDocument({
      slug: docSlug("runbook"),
      markdown: "# Runbook",
      clientVersion: 0,
      changedBy: "u",
    });
    await w.createCollection({
      slug: colSlug("ops"),
      name: "Ops",
      changedBy: "u",
    });
    await w.attachDocument(colSlug("ops"), docSlug("runbook"), 1, "u");

    const v1 = (await w.exportBundle(SOURCE)).collections["ops"]
      ?.collectionVersion;
    expect(v1).toBeGreaterThan(0);

    expect(
      (
        await w.updateCollection({
          slug: colSlug("ops"),
          name: "Operations",
          description: "On-call runbooks",
          changedBy: "erin",
        })
      ).ok,
    ).toBe(true);

    const r = await w.readCollection(colSlug("ops"));
    if (!r.found) throw new Error("collection vanished");
    expect(r.name).toBe("Operations");
    expect(r.description).toBe("On-call runbooks");
    // Membership unchanged.
    expect(r.documents.map((d) => d.slug)).toEqual(["runbook"]);

    const b2 = await w.exportBundle(SOURCE);
    // Slug is identity — still keyed "ops"; no new CollectionVersion.
    expect(b2.collections["ops"]?.name).toBe("Operations");
    expect(b2.collections["ops"]?.collectionVersion).toBe(v1);

    const [latest] = await w.recentChanges(1);
    expect(latest).toMatchObject({
      eventType: "collection.updated",
      changedBy: "erin",
    });
  });

  it("clears the description when passed empty", async () => {
    const w = freshStore("coledit");
    await w.createCollection({
      slug: colSlug("sales"),
      name: "Sales",
      description: "old",
      changedBy: "u",
    });
    await w.updateCollection({
      slug: colSlug("sales"),
      name: "Sales",
      changedBy: "u",
    });
    const r = await w.readCollection(colSlug("sales"));
    if (!r.found) throw new Error("collection vanished");
    expect(r.description ?? "").toBe("");
  });

  it("an unchanged name+description is an idempotent no-op", async () => {
    const w = freshStore("coledit");
    await w.createCollection({
      slug: colSlug("noop"),
      name: "NoOp",
      description: "desc",
      changedBy: "u",
    });
    const evtId = await w.lastEventId();
    expect(
      (
        await w.updateCollection({
          slug: colSlug("noop"),
          name: "NoOp",
          description: "desc",
          changedBy: "u",
        })
      ).ok,
    ).toBe(true);
    expect(await w.lastEventId()).toBe(evtId);
  });

  it("updating a missing collection is ok:false", async () => {
    const w = freshStore("coledit");
    expect(
      (
        await w.updateCollection({
          slug: colSlug("ghost"),
          name: "X",
          changedBy: "u",
        })
      ).ok,
    ).toBe(false);
  });
});
