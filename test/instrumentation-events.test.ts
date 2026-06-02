import { describe, expect, it } from "vitest";

import {
  decodeEvent,
  encodeEvent,
  events,
  eventType,
  idempotencyKey,
  INSTRUMENTATION_EVENT_SCHEMA_VERSION,
  type InstrumentationEvent,
} from "../src/store/domain/instrumentation-events";

// Pure-domain tests — no DO, no D1, no env. These pin the trust-
// boundary contract of the durable event stream's payload.

describe("instrumentation-events — schema version", () => {
  it("is at 2 (bumped with the Context → Collection rebrand)", () => {
    expect(INSTRUMENTATION_EVENT_SCHEMA_VERSION).toBe(2);
  });
});

describe("instrumentation-events — encode / decode round-trips", () => {
  it("round-trips every variant", () => {
    const samples: readonly InstrumentationEvent[] = [
      events.documentCreated({
        slug: "doc-1",
        docVersion: 1,
        title: "Doc 1",
        contentHash: "sha256:abc",
        changedBy: "u1",
      }),
      events.documentUpdated({
        slug: "doc-1",
        docVersion: 2,
        title: "Doc 1",
        contentHash: "sha256:def",
        changedBy: "u2",
      }),
      events.documentRenamed({
        slug: "doc-1",
        docVersion: 3,
        title: "Doc One",
        changedBy: "u1",
      }),
      events.documentArchived({
        slug: "doc-1",
        docVersion: 4,
        changedBy: "u1",
      }),
      events.collectionCreated({ collectionSlug: "ctx-A", changedBy: "u1" }),
      events.collectionAttached({
        collectionSlug: "ctx-A",
        documentSlug: "doc-1",
        position: 0,
        changedBy: "u1",
      }),
      events.collectionDetached({
        collectionSlug: "ctx-A",
        documentSlug: "doc-1",
        changedBy: "u1",
      }),
      events.collectionReordered({ collectionSlug: "ctx-A", changedBy: "u1" }),
      events.readFirst({
        callerRef: "apikey:k1",
        collectionSlug: "ctx-A",
        versionCapturedAtRead: { "doc-1": 2 },
      }),
      events.readAfterEdit({
        callerRef: "apikey:k1",
        collectionSlug: "ctx-A",
        versionCapturedAtRead: { "doc-1": 3 },
      }),
      events.callerConnected({ callerRef: "oauth:u-2" }),
      events.promptAnswered({
        bet: "shared-prompts-skills",
        answeredBy: "u1",
      }),
    ];
    for (const e of samples) {
      const decoded = decodeEvent(encodeEvent(e));
      expect(decoded).toEqual(e);
    }
  });

  it("rejects an event with a missing required field at the boundary", () => {
    // type: "document.created" requires `contentHash`; omit it.
    const bad = {
      type: "document.created",
      slug: "x",
      docVersion: 1,
      title: "X",
      changedBy: "u",
    };
    expect(() => encodeEvent(bad as unknown as InstrumentationEvent)).toThrow();
  });

  it("rejects an unknown event type at the boundary", () => {
    const bad = { type: "totally.invented", foo: "bar" };
    // decodeEvent goes through the same Zod gate — corrupt rows surface
    // here, never silently.
    expect(() => decodeEvent(JSON.stringify(bad))).toThrow();
  });

  it("rejects a numeric field with the wrong type", () => {
    const bad = {
      type: "document.created",
      slug: "x",
      docVersion: "1", // string, not number
      title: "X",
      contentHash: "sha256:x",
      changedBy: "u",
    };
    expect(() => decodeEvent(JSON.stringify(bad))).toThrow();
  });

  it("rejects an unknown prompt bet", () => {
    const bad = {
      type: "prompt.answered",
      bet: "invented-bet",
      answeredBy: "u",
    };
    expect(() => decodeEvent(JSON.stringify(bad))).toThrow();
  });
});

describe("instrumentation-events — eventType for the indexed column", () => {
  it("surfaces document.* and collection.* parent.kind", () => {
    expect(
      eventType(
        events.documentUpdated({
          slug: "x",
          docVersion: 1,
          title: "X",
          contentHash: "h",
          changedBy: "u",
        }),
      ),
    ).toBe("document.updated");
    expect(
      eventType(
        events.collectionAttached({
          collectionSlug: "c",
          documentSlug: "d",
          position: 0,
          changedBy: "u",
        }),
      ),
    ).toBe("collection.attached");
  });

  it("surfaces read events as `read.first` / `read.after-edit`", () => {
    const first = events.readFirst({
      callerRef: "apikey:k",
      collectionSlug: "c",
      versionCapturedAtRead: { d: 1 },
    });
    const afterEdit = events.readAfterEdit({
      callerRef: "apikey:k",
      collectionSlug: "c",
      versionCapturedAtRead: { d: 2 },
    });
    expect(eventType(first)).toBe("read.first");
    expect(eventType(afterEdit)).toBe("read.after-edit");
  });
});

describe("instrumentation-events — idempotency keys", () => {
  it("document events key on (type, slug, docVersion) — retry of the same save collapses", () => {
    const a = events.documentUpdated({
      slug: "doc-1",
      docVersion: 5,
      title: "X",
      contentHash: "h-a",
      changedBy: "u",
    });
    const b = events.documentUpdated({
      slug: "doc-1",
      docVersion: 5,
      title: "X",
      contentHash: "h-b", // content changed in retry; SHOULD NOT bypass dedup
      changedBy: "u",
    });
    expect(idempotencyKey(a)).toBe(idempotencyKey(b));
    expect(idempotencyKey(a)).toBe("document.updated:doc-1:v5");
  });

  it("collection.attached keys on (type, collectionSlug, member) — member is doc:<slug> or folder:<slug>", () => {
    expect(
      idempotencyKey(
        events.collectionAttached({
          collectionSlug: "ctx-A",
          documentSlug: "doc-1",
          position: 2,
          changedBy: "u",
        }),
      ),
    ).toBe("collection.attached:ctx-A:doc:doc-1");
    expect(
      idempotencyKey(
        events.collectionAttached({
          collectionSlug: "ctx-A",
          folderSlug: "f-1",
          position: 2,
          changedBy: "u",
        }),
      ),
    ).toBe("collection.attached:ctx-A:folder:f-1");
  });

  it("read.first keys on (caller, collection, fingerprint) — repeat reads at the same state collapse, different states do not (so a DO-restart re-emit at a moved state records the transition instead of colliding with the original)", () => {
    const a = events.readFirst({
      callerRef: "apikey:k1",
      collectionSlug: "ctx-A",
      versionCapturedAtRead: { d: 1 },
    });
    const b = events.readFirst({
      callerRef: "apikey:k1",
      collectionSlug: "ctx-A",
      versionCapturedAtRead: { d: 1 }, // same state → same key (still collapses on retry)
    });
    const c = events.readFirst({
      callerRef: "apikey:k1",
      collectionSlug: "ctx-A",
      versionCapturedAtRead: { d: 2 }, // state moved → distinct key (no silent drop)
    });
    expect(idempotencyKey(a)).toBe(idempotencyKey(b));
    expect(idempotencyKey(a)).not.toBe(idempotencyKey(c));
  });

  it("read.after-edit fingerprints on the captured version-set so a new edit gives a new key", () => {
    const a = events.readAfterEdit({
      callerRef: "apikey:k1",
      collectionSlug: "ctx-A",
      versionCapturedAtRead: { "doc-1": 5, "doc-2": 3 },
    });
    const b = events.readAfterEdit({
      callerRef: "apikey:k1",
      collectionSlug: "ctx-A",
      versionCapturedAtRead: { "doc-2": 3, "doc-1": 5 }, // key order shuffled — same fingerprint
    });
    const c = events.readAfterEdit({
      callerRef: "apikey:k1",
      collectionSlug: "ctx-A",
      versionCapturedAtRead: { "doc-1": 6, "doc-2": 3 }, // edit moved doc-1 v5→v6
    });
    expect(idempotencyKey(a)).toBe(idempotencyKey(b));
    expect(idempotencyKey(a)).not.toBe(idempotencyKey(c));
  });

  it("caller.connected keys on callerRef — second connect of same caller collapses", () => {
    const a = events.callerConnected({ callerRef: "oauth:u-2" });
    const b = events.callerConnected({ callerRef: "oauth:u-2" });
    expect(idempotencyKey(a)).toBe(idempotencyKey(b));
  });

  it("prompt.answered keys per answerer — one team member, one answer", () => {
    const a = events.promptAnswered({
      bet: "shared-prompts-skills",
      answeredBy: "u-1",
    });
    const b = events.promptAnswered({
      bet: "off-laptop-reactivity",
      answeredBy: "u-1",
    });
    expect(idempotencyKey(a)).toBe(idempotencyKey(b));
    expect(idempotencyKey(a)).toBe("prompt.answered:u-1");
  });
});
