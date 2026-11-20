import { createExecutionContext, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { connectControlDb } from "../src/control/db";
import {
  isStatsRefreshTick,
  PROJECT_STATS_REFRESH_UTC_HOUR,
  parseStoredStats,
  refreshAllProjectStats,
  refreshProjectStats,
  type StatsSource,
} from "../src/control/project-stats";
import { adminAudit, projectStats } from "../src/control/schema/app";
import { storeFor } from "../src/control/store-for";
import {
  ForbiddenError,
  InternalError,
  UnauthorizedError,
} from "../src/errors";
import type { ProjectId } from "../src/ids";
import {
  ADMIN_ACTION_REFRESH_PROJECT_STATS,
  refreshProjectStatsAsAdmin,
} from "../src/lib/server/admin";
import type { ServerRequestContext } from "../src/lib/server-context";
import {
  computeProjectStats,
  PROJECT_STATS_SCHEMA_VERSION,
} from "../src/store/domain/project-stats";

import { createOrg, docSlug, signUp } from "./_helpers";

const db = () => connectControlDb(env.DB);

async function seededProject(): Promise<ProjectId> {
  const { projectId } = await createOrg(await signUp("stats"));
  await storeFor(env, projectId).saveDocument({
    slug: docSlug("only"),
    markdown: "hello",
    clientVersion: 0,
    changedBy: "u",
  });
  return projectId;
}

async function rowOf(projectId: ProjectId) {
  const [row] = await db()
    .select()
    .from(projectStats)
    .where(eq(projectStats.projectId, projectId));
  return row;
}

describe("stats refresh job", () => {
  it("upserts one row per project and overwrites on re-run", async () => {
    const projectId = await seededProject();

    expect(await refreshProjectStats(env, projectId, 1_000)).toEqual({
      ok: true,
      computedAt: 1_000,
    });
    const first = await rowOf(projectId);
    expect(first?.schemaVersion).toBe(PROJECT_STATS_SCHEMA_VERSION);
    expect(first?.errorKind).toBeNull();
    expect(first?.computedAt?.getTime()).toBe(1_000);
    const parsed = first === undefined ? undefined : parseStoredStats(first);
    expect(parsed?.documents.live).toBe(1);

    await refreshProjectStats(env, projectId, 2_000);
    const all = await db()
      .select()
      .from(projectStats)
      .where(eq(projectStats.projectId, projectId));
    expect(all).toHaveLength(1);
    expect(all[0]?.computedAt?.getTime()).toBe(2_000);
  });

  it("isolates a failing project and records its error kind only", async () => {
    const healthy = await seededProject();
    const broken = await seededProject();
    const empty = computeProjectStats({
      archivedDocuments: 0,
      liveDocuments: [],
      corpora: [],
      folders: [],
      links: [],
    });
    const source: StatsSource = (id) =>
      id === broken
        ? Promise.reject(new InternalError("secret detail must not be stored"))
        : Promise.resolve(empty);

    const result = await refreshAllProjectStats(env, 5_000, source);

    expect(result.failed).toBeGreaterThanOrEqual(1);
    const healthyRow = await rowOf(healthy);
    expect(healthyRow?.errorKind).toBeNull();
    expect(healthyRow?.computedAt?.getTime()).toBe(5_000);

    const brokenRow = await rowOf(broken);
    expect(brokenRow?.errorKind).toBe("internal");
    expect(brokenRow?.statsJson).toBeNull();
    expect(brokenRow?.computedAt).toBeNull();
    expect(JSON.stringify(brokenRow)).not.toContain("secret detail");
  });

  it("keeps the last good snapshot when a later attempt fails", async () => {
    const projectId = await seededProject();
    await refreshProjectStats(env, projectId, 1_000);
    const failing: StatsSource = () =>
      Promise.reject(new InternalError("boom"));

    expect(await refreshProjectStats(env, projectId, 2_000, failing)).toEqual({
      ok: false,
      errorKind: "internal",
    });

    const row = await rowOf(projectId);
    expect(row?.errorKind).toBe("internal");
    expect(row?.computedAt?.getTime()).toBe(1_000);
    expect(row?.attemptedAt.getTime()).toBe(2_000);
    expect(row === undefined ? undefined : parseStoredStats(row)).toBeDefined();
  });

  it("refreshes only on the configured UTC hour tick", () => {
    const at = (hour: number) => Date.UTC(2026, 0, 10, hour, 0, 0);
    expect(isStatsRefreshTick(at(PROJECT_STATS_REFRESH_UTC_HOUR))).toBe(true);
    expect(isStatsRefreshTick(at(PROJECT_STATS_REFRESH_UTC_HOUR + 1))).toBe(
      false,
    );
  });
});

describe("admin refresh gate", () => {
  function contextFor(role: string | null | undefined): ServerRequestContext {
    return {
      env,
      executionCtx: createExecutionContext(),
      authSession:
        role === undefined
          ? undefined
          : { user: { id: "actor-1", email: "a@example.com", role } },
    };
  }

  it("refuses a signed-out caller", async () => {
    const projectId = await seededProject();
    await expect(
      refreshProjectStatsAsAdmin(contextFor(undefined), projectId),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(await rowOf(projectId)).toBeUndefined();
  });

  it("refuses a non-admin and writes neither stats nor audit", async () => {
    const projectId = await seededProject();
    await expect(
      refreshProjectStatsAsAdmin(contextFor("user"), projectId),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await rowOf(projectId)).toBeUndefined();
    const audit = await db()
      .select()
      .from(adminAudit)
      .where(eq(adminAudit.targetId, projectId));
    expect(audit).toEqual([]);
  });

  it("lets an admin refresh and records an audit row", async () => {
    const projectId = await seededProject();

    expect(
      await refreshProjectStatsAsAdmin(contextFor("admin"), projectId),
    ).toEqual({ ok: true });

    expect((await rowOf(projectId))?.errorKind).toBeNull();
    const audit = await db()
      .select()
      .from(adminAudit)
      .where(eq(adminAudit.targetId, projectId));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorUserId: "actor-1",
      action: ADMIN_ACTION_REFRESH_PROJECT_STATS,
      targetType: "project",
    });
  });
});
