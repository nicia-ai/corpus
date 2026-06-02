import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { connectControlDb } from "../src/control/db";
import { DEFAULT_PROJECT_SLUG } from "../src/control/org-lifecycle";
import {
  createProject,
  defaultProjectForOrgSlug,
  deleteProject,
  projectSlug,
  renameProject,
} from "../src/control/project-admin";
import {
  listAccessibleProjectsByOrg,
  resolveProjectById,
} from "../src/control/project-resolution";
import { organization } from "../src/control/schema/better-auth";

import { createOrg, signUp } from "./_helpers";

// The control-plane primitives behind the org+project switcher and the
// project-settings page. Server fns are thin transport over these (the
// owner-gate is one `requireOwner` line); the membership/lifecycle
// invariants they rely on are proven here against real D1.
describe("project lifecycle — create / rename / archive / grouped feed", () => {
  const sess = (id: string) => async () => ({ user: { id } });

  it("createProject yields a membership-resolvable, owner-roled project", async () => {
    const db = connectControlDb(env.DB);
    const userId = await signUp("pc");
    const { organizationId, projectId: defId } = await createOrg(userId);

    const newId = await createProject(db, organizationId, "Support KB");
    expect(newId).not.toBe(defId);

    const ref = await resolveProjectById(
      db,
      sess(userId),
      new Headers({ authorization: "Bearer pc-1" }),
      newId,
    );
    expect(ref?.projectId).toBe(newId);
    expect(ref?.organizationId).toBe(organizationId);
    expect(ref?.role).toBe("owner");

    // A non-default slug — what the archive guard keys on.
    expect(await projectSlug(db, newId)).not.toBe(DEFAULT_PROJECT_SLUG);
  });

  it("grouped feed lists every project under its org name; rename is metadata-only", async () => {
    const db = connectControlDb(env.DB);
    const userId = await signUp("pf");
    const { organizationId } = await createOrg(userId, "Acme Ops");
    const newId = await createProject(db, organizationId, "Support KB");

    const before = await listAccessibleProjectsByOrg(db, userId);
    const mine = before.filter((r) => r.organizationId === organizationId);
    expect(mine.map((r) => r.name).sort()).toEqual(["Default", "Support KB"]);
    expect(new Set(mine.map((r) => r.organizationName))).toEqual(
      new Set(["Acme Ops"]),
    );

    const created = mine.find((r) => r.projectId === newId);
    const slugBefore = created?.slug;
    await renameProject(db, newId, "Support Center");

    const after = await listAccessibleProjectsByOrg(db, userId);
    const renamed = after.find((r) => r.projectId === newId);
    expect(renamed?.name).toBe("Support Center");
    // Slug is identity — rename never touches it.
    expect(renamed?.slug).toBe(slugBefore);
  });

  it("archive (deleteProject) revokes access and drops from the feed; default survives", async () => {
    const db = connectControlDb(env.DB);
    const userId = await signUp("pa");
    const { organizationId, projectId: defId } = await createOrg(userId);
    const newId = await createProject(db, organizationId, "Scratch");

    await deleteProject(db, newId);

    const denied = await resolveProjectById(
      db,
      sess(userId),
      new Headers({ authorization: "Bearer pa-archived" }),
      newId,
    );
    expect(denied).toBeUndefined();

    const stillDefault = await resolveProjectById(
      db,
      sess(userId),
      new Headers({ authorization: "Bearer pa-default" }),
      defId,
    );
    expect(stillDefault?.projectId).toBe(defId);

    const feed = await listAccessibleProjectsByOrg(db, userId);
    const ids = feed
      .filter((r) => r.organizationId === organizationId)
      .map((r) => r.projectId);
    expect(ids).toContain(defId);
    expect(ids).not.toContain(newId);
  });

  it("defaultProjectForOrgSlug resolves the org's materialized default (additional-org path)", async () => {
    const userId = await signUp("pd");
    const { organizationId, projectId: defId } = await createOrg(userId);
    const db = connectControlDb(env.DB);

    const [org] = await db
      .select({ slug: organization.slug })
      .from(organization)
      .where(eq(organization.id, organizationId));
    expect(org).toBeDefined();

    const resolved = await defaultProjectForOrgSlug(db, org?.slug ?? "");
    expect(resolved).toBe(defId);

    expect(await projectSlug(db, defId)).toBe(DEFAULT_PROJECT_SLUG);
  });
});
