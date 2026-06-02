import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { connectControlDb } from "../src/control/db";
import { deleteProject } from "../src/control/project-admin";
import { reconcileProjects } from "../src/control/project-reconciliation";
import { resolveProject } from "../src/control/project-resolution";
import { project } from "../src/control/schema/app";

import { createOrg, docSlug, signUp } from "./_helpers";

describe("project lifecycle", () => {
  it("create → initializing → ready on first resolve", async () => {
    const uid = await signUp();
    const db = connectControlDb(env.DB);
    const { projectId } = await createOrg(uid, "LC One");

    const [before] = await db
      .select({ s: project.status })
      .from(project)
      .where(eq(project.id, projectId));
    expect(before?.s).toBe("initializing");

    const ref = await resolveProject(
      db,
      async () => ({ user: { id: uid } }),
      new Headers({ authorization: "Bearer lc1" }),
    );
    expect(ref?.projectId).toBe(projectId);

    const [after] = await db
      .select({ s: project.status })
      .from(project)
      .where(eq(project.id, projectId));
    expect(after?.s).toBe("ready");
  });

  it("deleteProject denies access immediately (status + epoch)", async () => {
    const uid = await signUp();
    const db = connectControlDb(env.DB);
    const { projectId } = await createOrg(uid, "LC Two");
    const headers = new Headers({ authorization: "Bearer lc2" });
    const getSession = async () => ({ user: { id: uid } });
    expect((await resolveProject(db, getSession, headers))?.projectId).toBe(
      projectId,
    );

    await deleteProject(db, projectId);
    expect(await resolveProject(db, getSession, headers)).toBeUndefined();
  });

  it("reconcile sweep purges soft-deleted project DO data", async () => {
    const uid = await signUp();
    const db = connectControlDb(env.DB);
    const { projectId } = await createOrg(uid, "LC Three");
    const stub = env.PROJECT_STORE.get(env.PROJECT_STORE.idFromName(projectId));
    await stub.saveDocument({
      slug: docSlug("doomed"),
      markdown: "to be purged",
      clientVersion: 0,
      changedBy: uid,
    });
    expect(await stub.getDocument(docSlug("doomed"))).toBeDefined();

    await deleteProject(db, projectId);
    const swept = await reconcileProjects(env);
    expect(swept).toBeGreaterThanOrEqual(1);
    expect(await stub.getDocument(docSlug("doomed"))).toBeUndefined(); // purged
  });
});
