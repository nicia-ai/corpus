import { describe, expect, it } from "vitest";

import { ConflictError } from "../src/errors";
import { verifyChain } from "../src/store/domain/verify";
import { nextVersion } from "../src/store/domain/versioning";
import {
  collectionVersionSnapshot,
  documentVersion,
} from "../src/store/domain/versions";
import { sha256 } from "../src/util";

import { colSlug, docSlug } from "./_helpers";

describe("nextVersion (pure conflict gate)", () => {
  it("first write of a new doc is v1", () => {
    expect(nextVersion(undefined, 0)).toBe(1);
  });

  it("matching client version advances the head", () => {
    expect(nextVersion({ docVersion: 7 }, 7)).toBe(8);
  });

  it("stale client version throws ConflictError carrying the server head", () => {
    try {
      nextVersion({ docVersion: 5 }, 2);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).currentVersion).toBe(5);
    }
  });

  it("creating a doc that already exists is a conflict against v0", () => {
    expect(() => nextVersion(undefined, 3)).toThrow(ConflictError);
  });
});

describe("version-model constructors (pure, zero-IO)", () => {
  it("genesis DocumentVersion has prevContentHash null", () => {
    const v = documentVersion({
      slug: docSlug("a"),
      docVersion: 1,
      contentHash: "sha256:aaa",
      prevContentHash: undefined,
      changedAt: "t0",
      changedBy: "u",
    });
    expect(v.prevContentHash).toBeNull();
    expect("diffSummary" in v).toBe(false);
  });

  it("a later DocumentVersion links to its predecessor's hash", () => {
    const v = documentVersion({
      slug: docSlug("a"),
      docVersion: 2,
      contentHash: "sha256:bbb",
      prevContentHash: "sha256:aaa",
      changedAt: "t1",
      changedBy: "u",
    });
    expect(v.prevContentHash).toBe("sha256:aaa");
  });

  it("CollectionVersionSnapshot carries the ordered member set verbatim", () => {
    const snap = collectionVersionSnapshot({
      collectionSlug: colSlug("ctx"),
      collectionVersion: 3,
      members: [
        {
          documentSlug: "a",
          docVersion: 2,
          contentHash: "sha256:b",
          position: 0,
        },
      ],
      changedAt: "t",
      changedBy: "u",
    });
    expect(snap.collectionVersion).toBe(3);
    expect(snap.members[0]?.documentSlug).toBe("a");
  });
});

describe("verifyChain (pure verifier)", () => {
  it("accepts an intact single-document chain", async () => {
    const h1 = await sha256("v1");
    const h2 = await sha256("v2");
    const r = await verifyChain({
      documents: [
        {
          slug: "a",
          versions: [
            { docVersion: 1, contentHash: h1, prevContentHash: null },
            { docVersion: 2, contentHash: h2, prevContentHash: h1 },
          ],
        },
      ],
      collections: [],
      blobs: new Map([
        [h1, "v1"],
        [h2, "v2"],
      ]),
    });
    expect(r).toEqual({ ok: true });
  });

  it("flags a tampered blob (content-hash mismatch)", async () => {
    const h1 = await sha256("v1");
    const r = await verifyChain({
      documents: [
        {
          slug: "a",
          versions: [{ docVersion: 1, contentHash: h1, prevContentHash: null }],
        },
      ],
      collections: [],
      blobs: new Map([[h1, "TAMPERED"]]),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.brokenAt).toMatchObject({
        kind: "document",
        slug: "a",
        reason: "content-hash-mismatch",
      });
    }
  });

  it("flags a broken parent link", async () => {
    const h1 = await sha256("v1");
    const h2 = await sha256("v2");
    const r = await verifyChain({
      documents: [
        {
          slug: "a",
          versions: [
            { docVersion: 1, contentHash: h1, prevContentHash: null },
            { docVersion: 2, contentHash: h2, prevContentHash: "sha256:wrong" },
          ],
        },
      ],
      collections: [],
      blobs: new Map([
        [h1, "v1"],
        [h2, "v2"],
      ]),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.brokenAt.reason).toBe("chain-broken");
  });

  it("flags a collection member that does not resolve to a version", async () => {
    const h1 = await sha256("v1");
    const r = await verifyChain({
      documents: [
        {
          slug: "a",
          versions: [{ docVersion: 1, contentHash: h1, prevContentHash: null }],
        },
      ],
      collections: [
        {
          collectionSlug: "ctx",
          collectionVersion: 1,
          members: [
            { documentSlug: "a", docVersion: 9, contentHash: h1, position: 0 },
          ],
        },
      ],
      blobs: new Map([[h1, "v1"]]),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.brokenAt).toMatchObject({
        kind: "collection",
        reason: "missing-version",
      });
    }
  });
});
