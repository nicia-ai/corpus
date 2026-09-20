import { env, SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { connectControlDb } from "../src/control/db";
import {
  mintEmbassy,
  resolveLiveEmbassy,
  revokeEmbassy,
  revokeEmbassiesForDocument,
} from "../src/control/embassies";
import { embassy } from "../src/control/schema/app";
import { storeFor } from "../src/control/store-for";
import { isIntakeMarkdown } from "../src/embassy/intake";
import { asEmbassyId, callerRefFromEmbassy, parseCallerRef } from "../src/ids";

import { createOrg, docSlug, signUp } from "./_helpers";

const ORIGIN = "https://example.com";

async function seedDoc(
  projectId: Parameters<typeof storeFor>[1],
  slug: string,
  markdown: string,
): Promise<void> {
  const r = await storeFor(env, projectId).saveDocument({
    slug: docSlug(slug),
    title: slug,
    markdown,
    clientVersion: 0,
    changedBy: "test",
  });
  expect(r.ok).toBe(true);
}

describe("embassy intake detection", () => {
  it("empty body after frontmatter is intake", () => {
    expect(isIntakeMarkdown("")).toBe(true);
    expect(isIntakeMarkdown("---\ntitle: x\n---\n\n")).toBe(true);
    expect(isIntakeMarkdown("# Hello\n")).toBe(false);
  });
});

describe("parseCallerRef embassy", () => {
  it("decodes embassy: prefix", () => {
    const id = asEmbassyId("abc");
    expect(parseCallerRef(callerRefFromEmbassy(id))).toEqual({
      kind: "embassy",
      id: "abc",
    });
  });
});

describe("Embassy admin scoping — cross-tenant guard", () => {
  it("revokeEmbassy scoped to the wrong project is a silent no-op", async () => {
    const alice = await signUp("em-a");
    const bob = await signUp("em-b");
    const orgA = await createOrg(alice, "Alice Org");
    const orgB = await createOrg(bob, "Bob Org");
    await seedDoc(orgA.projectId, "notes", "# hi\n");
    const db = connectControlDb(env.DB);
    const minted = await mintEmbassy(db, {
      projectId: orgA.projectId,
      documentSlug: docSlug("notes"),
      grant: "suggest",
    });
    await revokeEmbassy(db, { id: minted.id, projectId: orgB.projectId });
    const still = await resolveLiveEmbassy(db, minted.id);
    expect(still?.id).toBe(minted.id);
  });

  it("unshare scoped to the wrong project is a silent no-op", async () => {
    const alice = await signUp("em-us-a");
    const bob = await signUp("em-us-b");
    const orgA = await createOrg(alice, "Alice Org");
    const orgB = await createOrg(bob, "Bob Org");
    await seedDoc(orgA.projectId, "notes", "# hi\n");
    await seedDoc(orgB.projectId, "notes", "# bob\n");
    const db = connectControlDb(env.DB);
    const aLink = await mintEmbassy(db, {
      projectId: orgA.projectId,
      documentSlug: docSlug("notes"),
      grant: "read",
    });
    const bLink = await mintEmbassy(db, {
      projectId: orgB.projectId,
      documentSlug: docSlug("notes"),
      grant: "read",
    });
    await revokeEmbassiesForDocument(db, {
      projectId: orgB.projectId,
      documentSlug: docSlug("notes"),
    });
    expect(await resolveLiveEmbassy(db, aLink.id)).toBeDefined();
    expect(await resolveLiveEmbassy(db, bLink.id)).toBeUndefined();
  });
});

describe("Embassy HTTP", () => {
  it("GET markdown, revoke 404s, spent PUT is 403 not 409", async () => {
    const user = await signUp("em-http");
    const org = await createOrg(user, "Http Org");
    await seedDoc(org.projectId, "live-notes", "# Meeting\n\nHello.\n");
    await seedDoc(org.projectId, "intake-page", "");
    const db = connectControlDb(env.DB);
    const live = await mintEmbassy(db, {
      projectId: org.projectId,
      documentSlug: docSlug("live-notes"),
      grant: "suggest",
    });
    const viewOnly = await mintEmbassy(db, {
      projectId: org.projectId,
      documentSlug: docSlug("live-notes"),
      grant: "read",
    });
    const intake = await mintEmbassy(db, {
      projectId: org.projectId,
      documentSlug: docSlug("intake-page"),
      grant: "replace",
    });

    const md = await SELF.fetch(`${ORIGIN}/s/${live.id}`, {
      headers: { accept: "text/markdown" },
    });
    expect(md.status).toBe(200);
    expect(await md.text()).toContain("Hello.");
    expect(md.headers.get("x-doc-version")).toBe("1");

    const html = await SELF.fetch(`${ORIGIN}/s/${live.id}`, {
      headers: { accept: "text/html" },
    });
    expect(html.status).toBe(200);
    expect(await html.text()).toContain("Give this to your agent");

    const badPut = await SELF.fetch(`${ORIGIN}/s/${live.id}`, {
      method: "PUT",
      headers: {
        "content-type": "text/markdown",
        "x-doc-version": "1",
      },
      body: "# overwrite\n",
    });
    expect(badPut.status).toBe(403);

    const viewMd = await SELF.fetch(`${ORIGIN}/s/${viewOnly.id}`, {
      headers: { accept: "text/markdown" },
    });
    expect(viewMd.status).toBe(200);
    const viewPut = await SELF.fetch(`${ORIGIN}/s/${viewOnly.id}`, {
      method: "PUT",
      headers: {
        "content-type": "text/markdown",
        "x-doc-version": "1",
      },
      body: "# overwrite\n",
    });
    expect(viewPut.status).toBe(403);
    const viewSuggest = await SELF.fetch(`${ORIGIN}/s/${viewOnly.id}/suggest`, {
      method: "POST",
      headers: {
        "content-type": "text/markdown",
        "x-doc-version": "1",
      },
      body: "# proposed\n",
    });
    expect(viewSuggest.status).toBe(403);

    const getIntake = await SELF.fetch(`${ORIGIN}/s/${intake.id}`, {
      headers: { accept: "text/markdown" },
    });
    const ver = getIntake.headers.get("x-doc-version") ?? "1";
    const put1 = await SELF.fetch(`${ORIGIN}/s/${intake.id}`, {
      method: "PUT",
      headers: {
        "content-type": "text/markdown",
        "x-doc-version": ver,
      },
      body: "# Filled\n\nWiki notes.\n",
    });
    expect(put1.status).toBe(200);

    const put2 = await SELF.fetch(`${ORIGIN}/s/${intake.id}`, {
      method: "PUT",
      headers: {
        "content-type": "text/markdown",
        "x-doc-version": "2",
      },
      body: "# again\n",
    });
    expect(put2.status).toBe(403);

    await revokeEmbassy(db, { id: live.id, projectId: org.projectId });
    const gone = await SELF.fetch(`${ORIGIN}/s/${live.id}`, {
      headers: { accept: "text/markdown" },
    });
    expect(gone.status).toBe(404);

    const [row] = await db
      .select({ revokedAt: embassy.revokedAt })
      .from(embassy)
      .where(eq(embassy.id, live.id));
    expect(row?.revokedAt).not.toBeNull();
  });
});
