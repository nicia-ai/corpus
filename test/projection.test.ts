import { describe, expect, it } from "vitest";

import {
  encodeEvent,
  events,
  type InstrumentationEvent,
} from "../src/store/domain/instrumentation-events";
import {
  callerCollectionKey,
  EMPTY_PROJECTION,
  foldEvents,
  type ProjectionInput,
  type ProjectionState,
  toProjectionInput,
} from "../src/store/domain/projection";

// Pure-domain tests — no DO, no D1. The projection is a fold-only
// view of appended events; these pin its contractual invariants.

function input(
  monotonicId: number,
  timestamp: string,
  event: InstrumentationEvent,
): ProjectionInput {
  return { monotonicId, timestamp, event };
}

describe("projection — empty stream", () => {
  it("yields the empty projection", () => {
    const out = foldEvents([]);
    expect(out).toEqual(EMPTY_PROJECTION);
    expect(out.funnel.distinctCallerCount).toBe(0);
    expect(out.perCallerCollection.size).toBe(0);
  });
});

describe("projection — read events drive per-(caller,collection) state", () => {
  it("records last-read timestamp + version-captured for each (caller, collection)", () => {
    const out = foldEvents([
      input(
        1,
        "2026-05-19T10:00:00Z",
        events.readFirst({
          callerRef: "apikey:k1",
          collectionSlug: "ctx-A",
          versionCapturedAtRead: { "doc-1": 2 },
        }),
      ),
    ]);
    const state = out.perCallerCollection.get(
      callerCollectionKey("apikey:k1", "ctx-A"),
    );
    expect(state).toMatchObject({
      callerRef: "apikey:k1",
      collectionSlug: "ctx-A",
      lastReadAt: "2026-05-19T10:00:00Z",
      lastReadMonotonicId: 1,
      versionCapturedAtRead: { "doc-1": 2 },
    });
  });

  it("overwrites with the latest read for the same (caller, collection)", () => {
    const out = foldEvents([
      input(
        1,
        "2026-05-19T10:00:00Z",
        events.readFirst({
          callerRef: "apikey:k1",
          collectionSlug: "ctx-A",
          versionCapturedAtRead: { "doc-1": 2 },
        }),
      ),
      input(
        2,
        "2026-05-19T11:00:00Z",
        events.readAfterEdit({
          callerRef: "apikey:k1",
          collectionSlug: "ctx-A",
          versionCapturedAtRead: { "doc-1": 3 },
        }),
      ),
    ]);
    const state = out.perCallerCollection.get(
      callerCollectionKey("apikey:k1", "ctx-A"),
    );
    expect(state?.lastReadMonotonicId).toBe(2);
    expect(state?.versionCapturedAtRead).toEqual({ "doc-1": 3 });
  });

  it("keeps separate state for different callers reading the same collection", () => {
    const out = foldEvents([
      input(
        1,
        "2026-05-19T10:00:00Z",
        events.readFirst({
          callerRef: "apikey:k1",
          collectionSlug: "ctx-A",
          versionCapturedAtRead: { d: 1 },
        }),
      ),
      input(
        2,
        "2026-05-19T10:05:00Z",
        events.readFirst({
          callerRef: "oauth:user-2",
          collectionSlug: "ctx-A",
          versionCapturedAtRead: { d: 1 },
        }),
      ),
    ]);
    expect(out.perCallerCollection.size).toBe(2);
    expect(
      out.perCallerCollection.get(callerCollectionKey("apikey:k1", "ctx-A")),
    ).toBeDefined();
    expect(
      out.perCallerCollection.get(callerCollectionKey("oauth:user-2", "ctx-A")),
    ).toBeDefined();
  });
});

describe("projection — funnel signals", () => {
  it("firstMcpReadAt latches on the first read and never overwrites", () => {
    const out = foldEvents([
      input(
        1,
        "2026-05-19T10:00:00Z",
        events.readFirst({
          callerRef: "apikey:k1",
          collectionSlug: "ctx-A",
          versionCapturedAtRead: { d: 1 },
        }),
      ),
      input(
        2,
        "2026-05-19T11:00:00Z",
        events.readFirst({
          callerRef: "oauth:user-2",
          collectionSlug: "ctx-A",
          versionCapturedAtRead: { d: 1 },
        }),
      ),
    ]);
    expect(out.funnel.firstMcpReadAt).toBe("2026-05-19T10:00:00Z");
  });

  it("firstReadAfterEditAt latches on the first read.after-edit (not on read.first)", () => {
    const first = foldEvents([
      input(
        1,
        "2026-05-19T10:00:00Z",
        events.readFirst({
          callerRef: "apikey:k1",
          collectionSlug: "ctx-A",
          versionCapturedAtRead: { d: 1 },
        }),
      ),
    ]);
    expect(first.funnel.firstReadAfterEditAt).toBeUndefined();

    const afterEdit = foldEvents(
      [
        input(
          2,
          "2026-05-19T11:00:00Z",
          events.readAfterEdit({
            callerRef: "apikey:k1",
            collectionSlug: "ctx-A",
            versionCapturedAtRead: { d: 2 },
          }),
        ),
      ],
      first,
    );
    expect(afterEdit.funnel.firstReadAfterEditAt).toBe("2026-05-19T11:00:00Z");

    // Subsequent after-edit reads do NOT overwrite the latched first.
    const later = foldEvents(
      [
        input(
          3,
          "2026-05-19T12:00:00Z",
          events.readAfterEdit({
            callerRef: "apikey:k1",
            collectionSlug: "ctx-A",
            versionCapturedAtRead: { d: 3 },
          }),
        ),
      ],
      afterEdit,
    );
    expect(later.funnel.firstReadAfterEditAt).toBe("2026-05-19T11:00:00Z");
  });

  it("distinctCallerCount + secondDistinctCallerConnectedAt latch on the 2nd distinct caller", () => {
    const oneCaller = foldEvents([
      input(
        1,
        "2026-05-19T10:00:00Z",
        events.callerConnected({ callerRef: "apikey:k1" }),
      ),
      // A second event from the same caller does not bump the count.
      input(
        2,
        "2026-05-19T10:05:00Z",
        events.readFirst({
          callerRef: "apikey:k1",
          collectionSlug: "ctx-A",
          versionCapturedAtRead: { d: 1 },
        }),
      ),
    ]);
    expect(oneCaller.funnel.distinctCallerCount).toBe(1);
    expect(oneCaller.funnel.secondDistinctCallerConnectedAt).toBeUndefined();

    const twoCallers = foldEvents(
      [
        input(
          3,
          "2026-05-19T11:00:00Z",
          events.callerConnected({ callerRef: "oauth:user-2" }),
        ),
      ],
      oneCaller,
    );
    expect(twoCallers.funnel.distinctCallerCount).toBe(2);
    expect(twoCallers.funnel.secondDistinctCallerConnectedAt).toBe(
      "2026-05-19T11:00:00Z",
    );

    // A 3rd distinct caller does NOT overwrite the latched 2nd-connected moment.
    const threeCallers = foldEvents(
      [
        input(
          4,
          "2026-05-19T12:00:00Z",
          events.callerConnected({ callerRef: "apikey:k3" }),
        ),
      ],
      twoCallers,
    );
    expect(threeCallers.funnel.distinctCallerCount).toBe(3);
    expect(threeCallers.funnel.secondDistinctCallerConnectedAt).toBe(
      "2026-05-19T11:00:00Z",
    );
  });

  it("promptBet + promptAnsweredAt latch on the FIRST answer; subsequent answers are recorded but the signal sticks", () => {
    const after = foldEvents([
      input(
        1,
        "2026-05-19T10:00:00Z",
        events.promptAnswered({
          bet: "shared-prompts-skills",
          answeredBy: "user-1",
        }),
      ),
      input(
        2,
        "2026-05-19T11:00:00Z",
        events.promptAnswered({
          bet: "off-laptop-reactivity",
          answeredBy: "user-2",
        }),
      ),
    ]);
    expect(after.funnel.promptBet).toBe("shared-prompts-skills");
    expect(after.funnel.promptAnsweredAt).toBe("2026-05-19T10:00:00Z");
  });
});

describe("projection — document/collection lifecycle events are no-ops at fold level", () => {
  it("save events flow through the stream but the projection does not derive funnel state from them", () => {
    const out = foldEvents([
      input(
        1,
        "2026-05-19T10:00:00Z",
        events.documentCreated({
          slug: "doc-1",
          docVersion: 1,
          title: "Doc",
          contentHash: "sha256:abc",
          changedBy: "user-1",
        }),
      ),
      input(
        2,
        "2026-05-19T10:01:00Z",
        events.collectionAttached({
          collectionSlug: "ctx-A",
          documentSlug: "doc-1",
          position: 0,
          changedBy: "user-1",
        }),
      ),
    ]);
    // The projection should be empty — last-edit lives on the
    // DocumentVersion chain, not in the fold.
    expect(out).toEqual(EMPTY_PROJECTION);
  });
});

describe("projection — REBUILDABILITY invariant (the load-bearing one)", () => {
  // The whole point of the fold-only invariant: dropping the cache
  // and replaying the log MUST yield the same state as accumulating
  // event-by-event. This pin is the contract every consumer relies on.
  it("foldEvents(all) === foldEvents(all.slice(0,K)) → foldEvents(all.slice(K))", () => {
    const all: readonly ProjectionInput[] = [
      input(
        1,
        "2026-05-19T10:00:00Z",
        events.callerConnected({ callerRef: "apikey:k1" }),
      ),
      input(
        2,
        "2026-05-19T10:01:00Z",
        events.readFirst({
          callerRef: "apikey:k1",
          collectionSlug: "ctx-A",
          versionCapturedAtRead: { d: 1 },
        }),
      ),
      input(
        3,
        "2026-05-19T10:05:00Z",
        events.callerConnected({ callerRef: "oauth:user-2" }),
      ),
      input(
        4,
        "2026-05-19T10:10:00Z",
        events.readAfterEdit({
          callerRef: "apikey:k1",
          collectionSlug: "ctx-A",
          versionCapturedAtRead: { d: 2 },
        }),
      ),
      input(
        5,
        "2026-05-19T10:15:00Z",
        events.promptAnswered({
          bet: "version-quality-measurement",
          answeredBy: "user-1",
        }),
      ),
    ];

    const wholeFold = foldEvents(all);
    for (let k = 1; k < all.length; k += 1) {
      const headFold = foldEvents(all.slice(0, k));
      const incremental = foldEvents(all.slice(k), headFold);
      expect(incremental).toEqual(wholeFold);
    }
  });
});

describe("projection — toProjectionInput decodes EventLogStore envelopes", () => {
  it("round-trips a typed event through the encode/decode boundary into a ProjectionInput", () => {
    const event = events.readFirst({
      callerRef: "apikey:k1",
      collectionSlug: "ctx-A",
      versionCapturedAtRead: { d: 7 },
    });
    const envelope = {
      monotonicId: 42,
      timestamp: "2026-05-19T10:00:00Z",
      payload: encodeEvent(event),
    };
    const decoded = toProjectionInput(envelope);
    expect(decoded.monotonicId).toBe(42);
    expect(decoded.event).toEqual(event);

    // And the fold should see it identically to the in-memory construction.
    const viaFold: ProjectionState = foldEvents([decoded]);
    const direct: ProjectionState = foldEvents([
      input(42, "2026-05-19T10:00:00Z", event),
    ]);
    expect(viaFold).toEqual(direct);
  });
});
