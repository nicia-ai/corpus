import { describe, expect, it } from "vitest";

import { asCollectionSlug } from "../src/ids";
import { buildCollectionActivity } from "../src/lib/server/activity-view";
import {
  encodeEvent,
  events,
  eventType,
  type InstrumentationEvent,
} from "../src/store/domain/instrumentation-events";

// Port-driven tests — no DO, no D1. The builder receives the event log,
// the collection structure, and the id → name resolver as plain ports;
// these pin that authors in the feed are humanized through the resolver
// (the regression: raw user ids leaking into descriptions and
// lastEditBy) while agent caller refs keep their truncated labels.

const SLUG = asCollectionSlug("galileo-wiki");
const ALICE_ID = "QtvwujE8klpmiEXNp6H10K3dQZCPE1QV";
const NAMES = new Map([[ALICE_ID, "Galileo Tester"]]);

function envelope(
  monotonicId: number,
  event: InstrumentationEvent,
): Readonly<{
  monotonicId: number;
  schemaVersion: number;
  projectId: string;
  idempotencyKey: string;
  eventType: string;
  timestamp: string;
  payload: string;
}> {
  return {
    monotonicId,
    schemaVersion: 2,
    projectId: "p1",
    idempotencyKey: `k${String(monotonicId)}`,
    eventType: eventType(event),
    timestamp: `2026-07-13T00:00:0${String(monotonicId)}.000Z`,
    payload: encodeEvent(event),
  };
}

type BuilderArgs = Parameters<typeof buildCollectionActivity>[0];

function build(feed: readonly InstrumentationEvent[]) {
  const envelopes = feed.map((e, i) => envelope(i + 1, e));
  // The log port's type is a DO stub method (RPC-serialized returns); a
  // plain in-memory page function is behaviorally identical for the
  // builder, so one cast wires it.
  const log = {
    iterate: () => Promise.resolve(envelopes),
  } as unknown as BuilderArgs["log"];
  return buildCollectionActivity({
    slug: SLUG,
    mcpUrl: "https://corpus.test/mcp",
    store: {
      collectionStructure: () =>
        Promise.resolve({
          found: true as const,
          name: "Galileo Wiki",
          members: [{ slug: "wiki-index", docVersion: 3 }],
        }),
    },
    log,
    resolveNames: (ids) =>
      Promise.resolve(new Map([...NAMES].filter(([id]) => ids.includes(id)))),
  });
}

describe("buildCollectionActivity name resolution", () => {
  it("humanizes changedBy ids in feed descriptions and lastEditBy", async () => {
    const dto = await build([
      events.documentUpdated({
        slug: "wiki-index",
        docVersion: 3,
        title: "Galileo Wiki — Index",
        contentHash: "hash-a",
        changedBy: ALICE_ID,
      }),
    ]);
    expect(dto.recentActivity[0]?.description).toBe(
      "Galileo Tester edited wiki-index (v3)",
    );
    expect(dto.lastEditBy).toBe("Galileo Tester");
    expect(dto.lastEditAt).toBeDefined();
  });

  it("falls back to the raw id when the resolver has no name", async () => {
    const dto = await build([
      events.documentCreated({
        slug: "wiki-log",
        docVersion: 1,
        title: "Galileo Wiki — Log",
        contentHash: "hash-b",
        changedBy: "gone-user",
      }),
    ]);
    expect(dto.recentActivity[0]?.description).toBe(
      "gone-user created wiki-log",
    );
    expect(dto.lastEditBy).toBe("gone-user");
  });

  it("keeps truncated caller labels for agent events", async () => {
    const dto = await build([
      events.documentUpdated({
        slug: "wiki-index",
        docVersion: 3,
        title: "Galileo Wiki — Index",
        contentHash: "hash-a",
        changedBy: ALICE_ID,
      }),
      {
        type: "read",
        kind: "first",
        collectionSlug: "galileo-wiki",
        callerRef: "apikey:613d25bd-3dac-46a5-8f52-007081279d7b",
        versionCapturedAtRead: { "wiki-index": 3 },
      },
    ]);
    const readRow = dto.recentActivity.find((r) =>
      r.eventType.startsWith("read"),
    );
    expect(readRow?.description).toBe(
      "API key · 613d25bd… first read of galileo-wiki",
    );
  });
});
