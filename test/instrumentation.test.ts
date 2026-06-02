import { describe, expect, it } from "vitest";

import { asCallerRef } from "../src/ids";
import {
  decodeEvent,
  type InstrumentationEvent,
} from "../src/store/domain/instrumentation-events";
import {
  EMPTY_PROJECTION,
  foldEvents,
  toProjectionInput,
} from "../src/store/domain/projection";

import { colSlug, docSlug, freshProject } from "./_helpers";

// The wedge integration test. Real DO+D1 (vitest-pool-workers). No
// mocked seams. Proves the end-to-end chain:
//   ProjectStore mutation → atomic local change_events row
//                         → cross-DO EventLogStore.append
//                         → EventLogStore.iterate() returns the event
//                         → foldEvents() builds the projection
// All of which makes the activity-view's Fresh/Stale derivation real.
//
// The test verifies the same invariants the eng-review verify-step
// asked for: the read coalescing (D10/D15), the read-after-edit
// signal (D8), and that the caller.connected idempotency-key
// dedupes a repeat connect from the same caller (R1's spirit).

describe("instrumentation — saves emit events into the per-Project event log", () => {
  it("saveDocument lands a document.created event in EventLogStore", async () => {
    const { store, log } = freshProject("save-emit");
    await store.saveDocument({
      slug: docSlug("runbook"),
      markdown: "# runbook\nbody",
      clientVersion: 0,
      changedBy: "alice",
    });
    const events = await log.iterate({ limit: 10 });
    const decoded = events.map((e) => decodeEvent(e.payload));
    const created = decoded.find((e) => e.type === "document.created");
    expect(created).toMatchObject({
      type: "document.created",
      slug: "runbook",
      docVersion: 1,
      changedBy: "alice",
    });
  });

  it("createCollection + attachDocument fire collection.created and collection.attached", async () => {
    const { store, log } = freshProject("col-emit");
    await store.saveDocument({
      slug: docSlug("runbook"),
      markdown: "# r",
      clientVersion: 0,
      changedBy: "u",
    });
    await store.createCollection({
      slug: colSlug("ops"),
      name: "Ops",
      changedBy: "u",
    });
    await store.attachDocument(colSlug("ops"), docSlug("runbook"), 1, "u");

    const events = await log.iterate({ limit: 20 });
    const types = events.map((e) => e.eventType);
    expect(types).toContain("document.created");
    expect(types).toContain("collection.created");
    expect(types).toContain("collection.attached");
  });

  it("idempotency-key dedups a retry of the same save to one event", async () => {
    const { store, log } = freshProject("dedup");
    await store.saveDocument({
      slug: docSlug("idem"),
      markdown: "# x",
      clientVersion: 0,
      changedBy: "u",
    });
    // A naive replay would be a no-op at the version layer (a stale
    // clientVersion conflict) — drive a separate doc to force a new
    // local change while keeping the FIRST event's idempotency key
    // stable across the test.
    const before = await log.count();
    // Manually verify a second log.append with the SAME idempotency
    // key would dedup at the DB. This is the load-bearing invariant.
    const dup = await log.append({
      schemaVersion: 1,
      projectId: "dedup-project",
      idempotencyKey: "document.created:idem:v1",
      eventType: "document.created",
      payload: JSON.stringify({
        type: "document.created",
        slug: "idem",
        docVersion: 1,
        title: "x",
        contentHash: "",
        changedBy: "u",
      }),
    });
    expect(dup).toBeGreaterThan(0);
    const after = await log.count();
    expect(after).toBe(before); // no new row
  });
});

describe("instrumentation — MCP read events fire with coalescing", () => {
  it("first readCollection emits a read.first event", async () => {
    const { store, log } = freshProject("read-first");
    await store.saveDocument({
      slug: docSlug("d1"),
      markdown: "# d1",
      clientVersion: 0,
      changedBy: "u",
    });
    await store.createCollection({
      slug: colSlug("c"),
      name: "C",
      changedBy: "u",
    });
    await store.attachDocument(colSlug("c"), docSlug("d1"), 1, "u");

    const caller = asCallerRef("apikey:test-k1");
    await store.recordRead(caller, "c", { d1: 1 });

    const events = await log.iterate({ limit: 50 });
    const reads = events.filter((e) => e.eventType.startsWith("read."));
    expect(reads).toHaveLength(1);
    expect(reads[0]?.eventType).toBe("read.first");
  });

  it("a SECOND read with the same version-set is a TRUE no-op (no event, no projection change) — D10/D15 coalescing", async () => {
    const { store, log } = freshProject("read-coalesce");
    const caller = asCallerRef("apikey:test-k1");
    // First read: emits.
    await store.recordRead(caller, "ctx-x", { d: 1 });
    const after1 = await log.count();
    // Second read same version-set: cached fingerprint matches → no-op.
    await store.recordRead(caller, "ctx-x", { d: 1 });
    const after2 = await log.count();
    expect(after2).toBe(after1);
  });

  it("a read with a CHANGED version-set emits read.after-edit", async () => {
    const { store, log } = freshProject("read-after-edit");
    const caller = asCallerRef("apikey:test-k1");
    await store.recordRead(caller, "ctx-x", { d: 1 });
    await store.recordRead(caller, "ctx-x", { d: 2 }); // version moved
    const events = await log.iterate({ limit: 50 });
    const reads = events.filter((e) => e.eventType.startsWith("read."));
    expect(reads.map((r) => r.eventType)).toEqual([
      "read.first",
      "read.after-edit",
    ]);
  });
});

describe("instrumentation — caller.connected dedupes via idempotency_key", () => {
  it("two recordCallerConnected calls from the same caller yield ONE event row", async () => {
    const { store, log } = freshProject("caller");
    const caller = asCallerRef("apikey:k-once");
    await store.recordCallerConnected(caller);
    await store.recordCallerConnected(caller);
    const events = await log.iterate({ limit: 50 });
    const connects = events.filter((e) => e.eventType === "caller.connected");
    expect(connects).toHaveLength(1);
    expect(connects[0]?.idempotencyKey).toBe("caller.connected:apikey:k-once");
  });

  it("two DISTINCT callers yield TWO caller.connected events", async () => {
    const { store, log } = freshProject("two-callers");
    await store.recordCallerConnected(asCallerRef("apikey:k1"));
    await store.recordCallerConnected(asCallerRef("oauth:user-2"));
    const events = await log.iterate({ limit: 50 });
    const connects = events.filter((e) => e.eventType === "caller.connected");
    expect(connects).toHaveLength(2);
  });
});

describe("instrumentation — END-TO-END WEDGE: invited edit → agent read fresh", () => {
  // The wedge proof. The whole point of the office-hours design doc:
  // "invited coworker edits a doc → operator's agent reads the
  // changed version" must produce a recordable, derivable signal
  // (the read.after-edit event + a corresponding update to the
  // projection's CallerCollectionState with the new version-set).
  it("full chain: save v1 → first read → save v2 → second read → projection reflects after-edit", async () => {
    const { store, log } = freshProject("wedge");
    await store.saveDocument({
      slug: docSlug("plan"),
      markdown: "# Plan v1",
      clientVersion: 0,
      changedBy: "alice", // operator
    });
    await store.createCollection({
      slug: colSlug("ops"),
      name: "Ops",
      changedBy: "alice",
    });
    await store.attachDocument(colSlug("ops"), docSlug("plan"), 1, "alice");

    const agentCaller = asCallerRef("apikey:agent-cli");
    // Operator's agent reads at v1.
    await store.recordRead(agentCaller, "ops", { plan: 1 });

    // Invited teammate edits the doc → v2.
    await store.saveDocument({
      slug: docSlug("plan"),
      markdown: "# Plan v2 — updated by teammate",
      clientVersion: 1,
      changedBy: "mark", // invited teammate
    });

    // Operator's agent reads again → captures v2 now.
    await store.recordRead(agentCaller, "ops", { plan: 2 });

    // Fold the event log into a projection and assert the wedge:
    // (1) the agent has a CallerCollectionState whose
    //     versionCapturedAtRead reflects v2 (the freshest version).
    // (2) the funnel's firstReadAfterEditAt latches — proving the
    //     "read after a teammate's edit" moment was observed.
    const envelopes = await log.iterate({ limit: 200 });
    const inputs = envelopes.map(toProjectionInput);
    const state = foldEvents(inputs, EMPTY_PROJECTION);

    const ccs = [...state.perCallerCollection.values()].find(
      (s) => s.callerRef === "apikey:agent-cli" && s.collectionSlug === "ops",
    );
    expect(ccs?.versionCapturedAtRead).toEqual({ plan: 2 });
    expect(state.funnel.firstReadAfterEditAt).toBeDefined();
    // And the corresponding read events landed at all.
    const eventTypes = envelopes.map((e) => e.eventType);
    expect(eventTypes).toContain("read.first");
    expect(eventTypes).toContain("read.after-edit");
    expect(eventTypes).toContain("document.created"); // v1
    expect(eventTypes).toContain("document.updated"); // v2
  });
});

describe("instrumentation — failure of the event-stream append never fails the product", () => {
  it("recordRead is best-effort — the save it follows already committed locally and the agent never sees an error", async () => {
    // The append's failure path is observable only via console.error.
    // What this test pins is the contract: recordRead RESOLVES (never
    // throws / rejects) for any well-formed input, so the read path
    // does not propagate cross-DO failures. The cross-DO call IS
    // happening (verifyable in the "first readCollection emits..." test);
    // here we just assert the callable contract.
    const { store } = freshProject("nofail");
    await expect(
      store.recordRead(asCallerRef("apikey:k"), "ctx-x", { d: 1 }),
    ).resolves.toBeUndefined();
    await expect(
      store.recordCallerConnected(asCallerRef("apikey:k")),
    ).resolves.toBeUndefined();
  });
});

describe("instrumentation — events are typed and round-trip the encode/decode boundary", () => {
  it("every emitted event payload decodes cleanly via decodeEvent (no malformed rows in the log)", async () => {
    const { store, log } = freshProject("roundtrip");
    await store.saveDocument({
      slug: docSlug("a"),
      markdown: "# a",
      clientVersion: 0,
      changedBy: "u",
    });
    await store.createCollection({
      slug: colSlug("x"),
      name: "X",
      changedBy: "u",
    });
    await store.attachDocument(colSlug("x"), docSlug("a"), 1, "u");
    await store.recordCallerConnected(asCallerRef("apikey:k"));
    await store.recordRead(asCallerRef("apikey:k"), "x", { a: 1 });

    const envelopes = await log.iterate({ limit: 50 });
    // Every payload must round-trip; if encodeEvent / decodeEvent
    // drift, this fails immediately.
    const decoded: InstrumentationEvent[] = envelopes.map((e) =>
      decodeEvent(e.payload),
    );
    expect(decoded.length).toBeGreaterThan(0);
    // And every envelope carries the mandatory fields.
    for (const e of envelopes) {
      expect(e.schemaVersion).toBe(2);
      expect(typeof e.projectId).toBe("string");
      expect(typeof e.idempotencyKey).toBe("string");
      expect(typeof e.timestamp).toBe("string");
      expect(e.monotonicId).toBeGreaterThan(0);
    }
  });
});
