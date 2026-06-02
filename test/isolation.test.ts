import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { connectControlDb } from "../src/control/db";
import {
  resolveProject,
  resolveProjectById,
} from "../src/control/project-resolution";

import { addProject, createOrg, docSlug, signUp } from "./_helpers";

// MANDATORY, non-negotiable (design: the multi-tenant security boundary).
// A session scoped to project A must NEVER resolve to, or read/mutate,
// project B — even though B exists and holds data, and regardless of what
// slug is requested. Verified against real D1 + DO bindings.
describe("cross-tenant isolation (security gate)", () => {
  it("a user's session only ever resolves to their own project's DO", async () => {
    const uA = await signUp();
    const uB = await signUp();
    const db = connectControlDb(env.DB);
    const projA = await createOrg(uA, "Tenant A");
    const projB = await createOrg(uB, "Tenant B");
    expect(projA.projectId).not.toBe(projB.projectId);

    // B stores a secret in its own DO.
    const doB = env.PROJECT_STORE.get(
      env.PROJECT_STORE.idFromName(projB.projectId),
    );
    await doB.saveDocument({
      slug: docSlug("b-secret"),
      markdown: "tenant B confidential",
      clientVersion: 0,
      changedBy: uB,
    });
    expect((await doB.getDocument(docSlug("b-secret")))?.markdown).toContain(
      "confidential",
    );

    // A's session resolves ONLY to A — never B, even though B exists.
    for (const hdr of ["Bearer a-1", "Bearer a-2"]) {
      const ref = await resolveProject(
        db,
        async () => ({ user: { id: uA } }),
        new Headers({ authorization: hdr }),
      );
      expect(ref?.projectId).toBe(projA.projectId);
      expect(ref?.projectId).not.toBe(projB.projectId);
    }

    // The DO A is routed to cannot see B's data (distinct DO = distinct
    // SQLite; there is no client-supplied project id anywhere).
    const refA = await resolveProject(
      db,
      async () => ({ user: { id: uA } }),
      new Headers({ authorization: "Bearer a-3" }),
    );
    const doA = env.PROJECT_STORE.get(
      env.PROJECT_STORE.idFromName(refA?.projectId ?? "x"),
    );
    expect(await doA.getDocument(docSlug("b-secret"))).toBeUndefined();
    expect(await doA.listDocumentSlugs()).not.toContain("b-secret");

    // Sanity: B still sees its own data.
    const refB = await resolveProject(
      db,
      async () => ({ user: { id: uB } }),
      new Headers({ authorization: "Bearer b-1" }),
    );
    expect(refB?.projectId).toBe(projB.projectId);
  });

  it("the URL project id never crosses the membership boundary", async () => {
    const uA = await signUp();
    const uB = await signUp();
    const db = connectControlDb(env.DB);
    const orgA = await createOrg(uA, "Id Tenant A");
    const orgB = await createOrg(uB, "Id Tenant B");
    // Both orgs hold a project with the SAME slug "shared-name" but
    // distinct globally-unique ids — proving the slug is irrelevant and
    // routing is purely the id, gated by membership.
    const projBStaging = await addProject(
      orgB.organizationId,
      "shared-name",
      "B Staging",
    );
    const projAStaging = await addProject(
      orgA.organizationId,
      "shared-name",
      "A Staging",
    );
    expect(projAStaging).not.toBe(projBStaging);

    // A requests A's own id: resolves.
    const refA = await resolveProjectById(
      db,
      async () => ({ user: { id: uA } }),
      new Headers({ authorization: "Bearer id-iso-a" }),
      projAStaging,
    );
    expect(refA?.projectId).toBe(projAStaging);

    // B (distinct session) requests B's own id: resolves to B's.
    const refB = await resolveProjectById(
      db,
      async () => ({ user: { id: uB } }),
      new Headers({ authorization: "Bearer id-iso-b" }),
      projBStaging,
    );
    expect(refB?.projectId).toBe(projBStaging);

    // A presents B's *exact* project.id (the worst case — the secret is
    // known): membership scope still denies it. The id is not a
    // capability.
    const stolen = await resolveProjectById(
      db,
      async () => ({ user: { id: uA } }),
      new Headers({ authorization: "Bearer id-iso-steal" }),
      projBStaging,
    );
    expect(stolen).toBeUndefined();
  });

  it("a user with no membership resolves to nothing (no default tenant)", async () => {
    const orphan = await signUp();
    const db = connectControlDb(env.DB);
    const ref = await resolveProject(
      db,
      async () => ({ user: { id: orphan } }),
      new Headers({ authorization: "Bearer orphan" }),
    );
    expect(ref).toBeUndefined();
  });
});
