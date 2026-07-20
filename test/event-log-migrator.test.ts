import { describe, expect, it } from "vitest";

import { ledgerMigrations } from "../drizzle-event-log/migrations";

import { freshEventLog } from "./_helpers";

// The EventLogStore DO has its own SQLite + its own migration history,
// separate from ProjectStore's drizzle-do bundle. Sibling of
// `do-ledger-migrator.test.ts` — same shape pins, different schema.
// This is regression R2 from the plan: any new schema change to
// src/event-log-db.ts must regenerate the bundle (db:generate:event-log)
// and the test fails loudly if that drifts.
describe("EventLogStore Drizzle migrator", () => {
  it("the generated bundle is well-formed and covers the event_log table", () => {
    expect(ledgerMigrations.journal.entries.length).toBeGreaterThanOrEqual(1);
    const first = ledgerMigrations.journal.entries[0];
    expect(first?.idx).toBe(0);
    const sql = ledgerMigrations.migrations.m0000;
    expect(sql).toBeDefined();
    expect(sql).toContain("CREATE TABLE `event_log`");
    expect(sql).toContain("idempotency_key");
    // Unique index on idempotency_key is the dedup hard-gate; missing
    // it would let retried appends double-insert.
    expect(sql).toContain("event_log_idempotency_key_unique");
  });

  it("a fresh EventLogStore inits via the migrator; append + iterate work", async () => {
    const log = freshEventLog();

    expect(await log.count()).toBe(0);

    const id1 = await log.append({
      schemaVersion: 1,
      projectId: "proj-A",
      idempotencyKey: "save:doc-1:v1",
      eventType: "document.created",
      payload: JSON.stringify({ slug: "doc-1", docVersion: 1 }),
    });
    expect(id1).toBeGreaterThan(0);

    const id2 = await log.append({
      schemaVersion: 1,
      projectId: "proj-A",
      idempotencyKey: "read:agent-X:ctx-Y:v1",
      eventType: "read.first",
      payload: JSON.stringify({ caller: "apikey:k1", collectionSlug: "ctx-Y" }),
    });
    expect(id2).toBeGreaterThan(id1);

    expect(await log.count()).toBe(2);
    const usage = await log.usageSnapshot();
    expect(usage.events).toBe(2);
    expect(usage.storedEventBytes).toBeGreaterThan(0);

    const all = await log.iterate();
    expect(all.map((e) => e.eventType)).toEqual([
      "document.created",
      "read.first",
    ]);
    expect(all[0]?.monotonicId).toBe(id1);
    expect(all[1]?.monotonicId).toBe(id2);
    // Envelope: every appended row must carry the mandatory fields
    // (Codex #4 — schema-version, project id, monotonic id, idempotency
    // key, timestamp).
    expect(all[0]).toMatchObject({
      schemaVersion: 1,
      projectId: "proj-A",
      idempotencyKey: "save:doc-1:v1",
      eventType: "document.created",
    });
    expect(typeof all[0]?.timestamp).toBe("string");
    expect(all[0]?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("idempotency-key retry collapses to the original event id", async () => {
    const log = freshEventLog();

    const key = "save:runbook:v7";
    const first = await log.append({
      schemaVersion: 1,
      projectId: "proj-B",
      idempotencyKey: key,
      eventType: "document.updated",
      payload: "{}",
    });

    // Retry with the SAME key (different payload to prove the original
    // wins — never the retry's content) must return the original id and
    // NOT add a second row.
    const retry = await log.append({
      schemaVersion: 1,
      projectId: "proj-B",
      idempotencyKey: key,
      eventType: "document.updated",
      payload: JSON.stringify({ should: "not appear in log" }),
    });

    expect(retry).toBe(first);
    expect(await log.count()).toBe(1);
    const [only] = await log.iterate();
    expect(only?.payload).toBe("{}");
  });

  it("iterate honors sinceMonotonicId cursor (exclusive) and limit", async () => {
    const log = freshEventLog();

    const ids: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(
        await log.append({
          schemaVersion: 1,
          projectId: "proj-C",
          idempotencyKey: `e${String(i)}`,
          eventType: "read.after-edit",
          payload: "{}",
        }),
      );
    }

    // `noUncheckedIndexedAccess` types ids[1] as possibly-undefined; the loop
    // above appended five, so assert that rather than defaulting past a real
    // seeding failure and silently iterating from the head.
    const since = ids[1];
    if (since === undefined) throw new Error("expected 5 appended event ids");
    const tail = await log.iterate({ sinceMonotonicId: since });
    expect(tail.map((e) => e.monotonicId)).toEqual([ids[2], ids[3], ids[4]]);

    const page = await log.iterate({ limit: 2 });
    expect(page.length).toBe(2);
    expect(page[0]?.monotonicId).toBe(ids[0]);
  });
});
