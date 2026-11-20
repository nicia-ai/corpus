import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { connectControlDb } from "../src/control/db";
import { reconcileRetention } from "../src/control/project-reconciliation";
import { project } from "../src/control/schema/app";
import {
  cutoffIso,
  parseRetention,
  planVersionReap,
} from "../src/store/domain/retention";

import { createOrg, colSlug, docSlug, freshStore, signUp } from "./_helpers";

const DAY = 86_400_000;

describe("retention domain (pure)", () => {
  it("parses the ProjectPolicy retention subset, defaulting to forever", () => {
    expect(parseRetention(null)).toEqual({});
    expect(parseRetention("")).toEqual({});
    expect(parseRetention("not json")).toEqual({});
    expect(parseRetention('{"retention":{"documentVersionDays":7}}')).toEqual({
      documentVersionDays: 7,
    });
    // strict: unknown keys reject → forever (no accidental reaping).
    expect(parseRetention('{"retention":{"foo":1}}')).toEqual({});
    expect(parseRetention('{"other":true}')).toEqual({});
  });

  it("cutoffIso is the instant `days` before now", () => {
    const now = Date.UTC(2026, 0, 10);
    expect(cutoffIso(now, 3)).toBe(new Date(now - 3 * DAY).toISOString());
  });

  it("keeps head + pinned, deletes only old non-head non-pinned versions", () => {
    const plan = planVersionReap({
      versions: [
        {
          id: "a1",
          slug: "a",
          docVersion: 1,
          changedAt: "2026-01-01",
          contentHash: "h1",
        },
        {
          id: "a2",
          slug: "a",
          docVersion: 2,
          changedAt: "2026-01-02",
          contentHash: "h2",
        },
        {
          id: "a3",
          slug: "a",
          docVersion: 3,
          changedAt: "2026-01-03",
          contentHash: "h3",
        },
      ],
      cutoffIso: "2026-06-01",
      pinned: new Set(["a 2"]),
    });
    expect(plan.deleteIds).toEqual(["a1"]); // v2 pinned, v3 head
    expect([...plan.survivingHashes].sort()).toEqual(["h2", "h3"]);
  });
});

describe("reapExpired (DO end-to-end, clock-seamed)", () => {
  it("reaps old non-head, non-pinned versions; head + pinned + verify survive", async () => {
    const store = freshStore("reap");
    await store.createCorpus({
      slug: colSlug("c"),
      name: "C",
      changedBy: "u",
    });
    // Creating the document in a corpus cuts a CorpusVersion that pins v1.
    // v2 is unpinned and non-head; v3 is the head. Only v2 may be reaped.
    await store.saveDocument({
      slug: docSlug("a"),
      markdown: "v1",
      location: { corpusSlug: colSlug("c"), folderSlug: null },
      clientVersion: 0,
      changedBy: "u",
    });
    await store.saveDocument({
      slug: docSlug("a"),
      markdown: "v2",
      clientVersion: 1,
      changedBy: "u",
    });
    await store.saveDocument({
      slug: docSlug("a"),
      markdown: "v3",
      clientVersion: 2,
      changedBy: "u",
    });
    expect(await store.versionCount(docSlug("a"))).toBe(3);

    const r = await store.reapExpired(
      { documentVersionDays: 1 },
      Date.now() + 5 * DAY,
    );
    expect(r.versionsDeleted).toBe(1);
    expect(await store.versionCount(docSlug("a"))).toBe(2); // pinned v1 + head v3
    expect((await store.getDocument(docSlug("a")))?.markdown).toBe("v3");
    expect(await store.verifyHistory()).toEqual({ ok: true });
  });

  it("reaps change events and unreferenced blobs past their windows", async () => {
    const store = freshStore("reap");
    // v1 is pinned by its creation snapshot; v2 is the only unpinned non-head
    // version, so its bytes are the blob that becomes an orphan.
    for (const [v, body] of [
      [0, "one"],
      [1, "two"],
      [2, "three"],
    ] as const) {
      await store.saveDocument({
        slug: docSlug("d"),
        markdown: body,
        clientVersion: v,
        changedBy: "u",
      });
    }
    const future = Date.now() + 5 * DAY;

    const versions = await store.reapExpired(
      { documentVersionDays: 1 },
      future,
    );
    expect(versions.versionsDeleted).toBe(1);
    const r = await store.reapExpired(
      { changeEventDays: 1, blobDays: 1 },
      future,
    );
    expect(r.eventsDeleted).toBeGreaterThanOrEqual(1);
    expect(r.blobsDeleted).toBeGreaterThanOrEqual(1); // v2 bytes, now orphan
    // Head still resolves (its blob is referenced, never reaped).
    expect((await store.getDocument(docSlug("d")))?.markdown).toBe("three");
    expect(await store.verifyHistory()).toEqual({ ok: true });
  });

  it("an absent window reaps nothing (forever)", async () => {
    const store = freshStore("reap");
    await store.saveDocument({
      slug: docSlug("k"),
      markdown: "keep",
      clientVersion: 0,
      changedBy: "u",
    });
    const r = await store.reapExpired({}, Date.now() + 9999 * DAY);
    expect(r).toEqual({
      versionsDeleted: 0,
      eventsDeleted: 0,
      blobsDeleted: 0,
    });
    expect(await store.versionCount(docSlug("k"))).toBe(1);
  });
});

describe("reconcileRetention (control-plane sweep wiring)", () => {
  it("sweeps only projects that declare a retention policy", async () => {
    const uid = await signUp();
    const db = connectControlDb(env.DB);
    const created = await createOrg(uid, "Reap Co");
    await db
      .update(project)
      .set({ policy: JSON.stringify({ retention: { changeEventDays: 30 } }) })
      .where(eq(project.id, created.projectId));

    // Real wall clock → fresh data is inside the window, nothing deleted,
    // but the project is swept (policy present) — proves the wiring.
    const swept = await reconcileRetention(env);
    expect(swept).toBeGreaterThanOrEqual(1);
  });
});
