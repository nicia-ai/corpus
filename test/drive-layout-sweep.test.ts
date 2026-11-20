import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { connectControlDb } from "../src/control/db";
import { reconcileDriveLayout } from "../src/control/project-reconciliation";
import { connection } from "../src/control/schema/app";
import { storeFor } from "../src/control/store-for";
import { InternalError } from "../src/errors";
import type { ProjectId } from "../src/ids";
import { DEFAULT_CORPUS_SLUG } from "../src/store/domain/default-corpus";

import { createOrg, docSlug, signUp } from "./_helpers";

type Seeded = Readonly<{ projectId: ProjectId; organizationId: string }>;

async function seededProject(): Promise<Seeded> {
  const org = await createOrg(await signUp("layout-sweep"));
  await storeFor(env, org.projectId).saveDocument({
    slug: docSlug("only"),
    markdown: "hello",
    clientVersion: 0,
    changedBy: "u",
  });
  return { projectId: org.projectId, organizationId: org.organizationId };
}

async function bindConnection(seeded: Seeded, corpusSlug: string) {
  await connectControlDb(env.DB).insert(connection).values({
    id: crypto.randomUUID(),
    organizationId: seeded.organizationId,
    projectId: seeded.projectId,
    collectionSlug: corpusSlug,
    name: "agent",
  });
}

describe("drive layout sweep", () => {
  it("repairs only projects with a default-corpus binding between daily runs", async () => {
    const locked = await seededProject();
    const served = await seededProject();
    const unconnected = await seededProject();
    await bindConnection(locked, DEFAULT_CORPUS_SLUG);
    await bindConnection(served, "handbook");

    const visited: ProjectId[] = [];
    await reconcileDriveLayout(env, "default-bound", (projectId) => {
      visited.push(projectId);
      return Promise.resolve();
    });

    expect(visited).toContain(locked.projectId);
    expect(visited).not.toContain(served.projectId);
    expect(visited).not.toContain(unconnected.projectId);
  });

  it("visits every live project on the daily run and isolates a failure", async () => {
    const healthy = await seededProject();
    const broken = await seededProject();

    const visited: ProjectId[] = [];
    const result = await reconcileDriveLayout(env, "all", (projectId) => {
      visited.push(projectId);
      return projectId === broken.projectId
        ? Promise.reject(new InternalError("layout failed"))
        : Promise.resolve();
    });

    expect(visited).toContain(healthy.projectId);
    expect(visited).toContain(broken.projectId);
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(result.laidOut).toBeGreaterThanOrEqual(1);
  });

  it("lays a project out through its store and is a no-op afterwards", async () => {
    const seeded = await seededProject();
    const store = storeFor(env, seeded.projectId);

    await store.layOutAsDrivesIfNeeded();
    const before = await store.listDocuments();
    await store.layOutAsDrivesIfNeeded();

    expect(await store.listDocuments()).toEqual(before);
  });
});
