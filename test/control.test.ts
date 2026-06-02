import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { bumpAuthEpoch } from "../src/control/access";
import { connectControlDb } from "../src/control/db";
import { deleteProject, membershipCount } from "../src/control/project-admin";
import {
  accessibleProject,
  resolveProject,
  resolveProjectById,
} from "../src/control/project-resolution";
import { member } from "../src/control/schema/better-auth";

import { addProject, createOrg, signUp } from "./_helpers";

// Identity (organization + member) is owned by the Better Auth org
// plugin; `createOrg` seeds it + the default project exactly as
// `auth.api.createOrganization` + the afterCreateOrganization hook do.
// These tests exercise tenancy *resolution* over that model; the
// plugin's invite/accept/create HTTP flow is covered in team.test.ts.
describe("control plane — project resolution over Better Auth member", () => {
  it("signup → org+member+project → resolve returns the owner ref", async () => {
    const userId = await signUp();
    const db = connectControlDb(env.DB);
    const created = await createOrg(userId, "Acme Ops");

    const ref = await resolveProject(
      db,
      async () => ({ user: { id: userId } }),
      new Headers({ authorization: "Bearer tok-1" }),
    );
    expect(ref).toEqual({
      organizationId: created.organizationId,
      projectId: created.projectId,
      userId,
      role: "owner",
    });
    expect(await membershipCount(db, created.organizationId)).toBe(1);
  });

  it("a single default project is resolvable by id", async () => {
    const userId = await signUp();
    const db = connectControlDb(env.DB);
    const created = await createOrg(userId, "Beta Co");
    const ref = await resolveProject(
      db,
      async () => ({ user: { id: userId } }),
      new Headers({ authorization: "Bearer tok-default" }),
    );
    expect(ref?.projectId).toBe(created.projectId);
    expect(ref?.organizationId).toBe(created.organizationId);
  });

  it("no session → unauthorized (undefined)", async () => {
    const db = connectControlDb(env.DB);
    const ref = await resolveProject(
      db,
      async () => null,
      new Headers({ authorization: "Bearer nope" }),
    );
    expect(ref).toBeUndefined();
  });

  it("auth-epoch bump invalidates the cache (no stale serve)", async () => {
    const userId = await signUp();
    const db = connectControlDb(env.DB);
    const created = await createOrg(userId, "Gamma");
    const headers = new Headers({ authorization: "Bearer tok-epoch" });
    const getSession = async () => ({ user: { id: userId } });

    const first = await resolveProject(db, getSession, headers); // caches epoch 0
    expect(first?.projectId).toBe(created.projectId);

    await bumpAuthEpoch(db, created.projectId); // epoch → 1
    const after = await resolveProject(db, getSession, headers);
    expect(after?.projectId).toBe(created.projectId);
  });

  it("removed member loses access promptly via epoch, not after TTL", async () => {
    const userId = await signUp();
    const db = connectControlDb(env.DB);
    const created = await createOrg(userId, "Delta");
    const headers = new Headers({ authorization: "Bearer tok-revoke" });
    const getSession = async () => ({ user: { id: userId } });

    expect((await resolveProject(db, getSession, headers))?.projectId).toBe(
      created.projectId,
    );

    // Destructive event: remove the member + bump the project epoch
    // (exactly what the org plugin's afterRemoveMember hook does).
    await db.delete(member).where(eq(member.userId, userId));
    await bumpAuthEpoch(db, created.projectId);

    const revoked = await resolveProject(db, getSession, headers);
    expect(revoked).toBeUndefined();
  });

  it("after a project soft-delete the user is not stuck — a fresh org resolves", async () => {
    const userId = await signUp();
    const db = connectControlDb(env.DB);
    const old = await createOrg(userId, "Doomed");
    await deleteProject(db, old.projectId);

    // The dead default project must not count as the user's project.
    expect(await accessibleProject(db, userId)).toBeUndefined();

    const fresh = await createOrg(userId, "Reborn");
    const ref = await resolveProject(
      db,
      async () => ({ user: { id: userId } }),
      new Headers({ authorization: "Bearer reborn" }),
    );
    expect(ref?.projectId).toBe(fresh.projectId);
    expect(ref?.projectId).not.toBe(old.projectId);
  });
});

// The URL-named resolver. `resolveProject` pins to the user's *default*
// project; `resolveProjectById` takes the globally-unique `project.id`
// from the `/p/$projectId` path. The membership join is the new
// authorization surface — an id the session is not a member of must
// never resolve (project.id is unguessable AND scoped, two layers).
describe("control plane — resolveProjectById (URL-named project)", () => {
  it("resolves the default project by its id", async () => {
    const userId = await signUp();
    const db = connectControlDb(env.DB);
    const created = await createOrg(userId, "Acme Id");

    const ref = await resolveProjectById(
      db,
      async () => ({ user: { id: userId } }),
      new Headers({ authorization: "Bearer id-default" }),
      created.projectId,
    );
    expect(ref).toEqual({
      organizationId: created.organizationId,
      projectId: created.projectId,
      userId,
      role: "owner",
    });
  });

  it("resolves a non-default project in the same org by its id", async () => {
    const userId = await signUp();
    const db = connectControlDb(env.DB);
    const created = await createOrg(userId, "Multi Co");
    const secondId = await addProject(
      created.organizationId,
      "staging",
      "Staging",
    );

    const ref = await resolveProjectById(
      db,
      async () => ({ user: { id: userId } }),
      new Headers({ authorization: "Bearer id-staging" }),
      secondId,
    );
    expect(ref?.projectId).toBe(secondId);
    expect(ref?.projectId).not.toBe(created.projectId);
  });

  it("denies an id the session is not a member of (cross-org)", async () => {
    const insider = await signUp();
    const outsider = await signUp();
    const db = connectControlDb(env.DB);
    const acme = await createOrg(insider, "Acme Private");
    const secret = await addProject(
      acme.organizationId,
      "secret-proj",
      "Secret",
    );

    // Outsider belongs to their own org; even with Acme's exact
    // project.id they are not a member, so it must not resolve.
    await createOrg(outsider, "Outsider Org");
    const ref = await resolveProjectById(
      db,
      async () => ({ user: { id: outsider } }),
      new Headers({ authorization: "Bearer id-cross" }),
      secret,
    );
    expect(ref).toBeUndefined();
  });

  it("same session, two ids: the isolate cache is project-scoped (no alias)", async () => {
    const userId = await signUp();
    const db = connectControlDb(env.DB);
    const created = await createOrg(userId, "Two Ids");
    const staging = await addProject(created.organizationId, "stg", "Stg");
    const headers = new Headers({ authorization: "Bearer two-id" });
    const getSession = async () => ({ user: { id: userId } });

    // First resolve caches the default project under <token>+<id>.
    const a = await resolveProjectById(
      db,
      getSession,
      headers,
      created.projectId,
    );
    expect(a?.projectId).toBe(created.projectId);
    // Same token, different id must NOT return the cached default.
    const b = await resolveProjectById(db, getSession, headers, staging);
    expect(b?.projectId).toBe(staging);
    expect(b?.projectId).not.toBe(created.projectId);
    // And the first id still resolves correctly afterwards.
    const a2 = await resolveProjectById(
      db,
      getSession,
      headers,
      created.projectId,
    );
    expect(a2?.projectId).toBe(created.projectId);
  });

  it("unknown id → undefined", async () => {
    const userId = await signUp();
    const db = connectControlDb(env.DB);
    await createOrg(userId, "Known Org");
    const ref = await resolveProjectById(
      db,
      async () => ({ user: { id: userId } }),
      new Headers({ authorization: "Bearer id-unknown" }),
      "no-such-project-id",
    );
    expect(ref).toBeUndefined();
  });

  it("no session → undefined", async () => {
    const db = connectControlDb(env.DB);
    const ref = await resolveProjectById(
      db,
      async () => null,
      new Headers({ authorization: "Bearer id-nosession" }),
      "any-id",
    );
    expect(ref).toBeUndefined();
  });

  it("soft-deleted project by id → undefined (no resurrection via URL)", async () => {
    const userId = await signUp();
    const db = connectControlDb(env.DB);
    const created = await createOrg(userId, "Doomed Id");
    const staging = await addProject(
      created.organizationId,
      "doomed-stg",
      "Doomed Staging",
    );
    await deleteProject(db, staging);

    const ref = await resolveProjectById(
      db,
      async () => ({ user: { id: userId } }),
      new Headers({ authorization: "Bearer id-doomed" }),
      staging,
    );
    expect(ref).toBeUndefined();
  });
});
