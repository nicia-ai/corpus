import { env, SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { markProjectBroken } from "../src/control/access";
import { connectControlDb } from "../src/control/db";
import {
  EMBASSY_WRITE_LIMIT,
  mintEmbassy,
  resolveLiveEmbassy,
  revokeEmbassy,
  revokeEmbassiesForDocument,
  setEmbassyGrant,
} from "../src/control/embassies";
import { createProject, deleteProject } from "../src/control/project-admin";
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

  it("grant change scoped to the wrong project is a silent no-op", async () => {
    const alice = await signUp("em-gr-a");
    const bob = await signUp("em-gr-b");
    const orgA = await createOrg(alice, "Alice Org");
    const orgB = await createOrg(bob, "Bob Org");
    await seedDoc(orgA.projectId, "notes", "# hi\n");
    const db = connectControlDb(env.DB);
    const link = await mintEmbassy(db, {
      projectId: orgA.projectId,
      documentSlug: docSlug("notes"),
      grant: "read",
    });
    const stray = await setEmbassyGrant(db, {
      id: link.id,
      projectId: orgB.projectId,
      grant: "edit",
    });
    expect(stray).toBeUndefined();
    expect((await resolveLiveEmbassy(db, link.id))?.grant).toBe("read");

    await revokeEmbassy(db, { id: link.id, projectId: orgA.projectId });
    const revived = await setEmbassyGrant(db, {
      id: link.id,
      projectId: orgA.projectId,
      grant: "edit",
    });
    expect(revived).toBeUndefined();
  });
});

describe("Embassy HTTP", () => {
  it("GET markdown, revoke 404s, edit PUTs repeat until switched to suggest", async () => {
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
      grant: "edit",
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
      body: "# Revised\n\nWiki notes, round two.\n",
    });
    expect(put2.status).toBe(200);
    const review = await storeFor(env, org.projectId).documentReviewSnapshot(
      docSlug("intake-page"),
    );
    expect(review.headChange?.changedBy).toBe(callerRefFromEmbassy(intake.id));
    const revised = await storeFor(env, org.projectId).getDocument(
      docSlug("intake-page"),
    );
    expect(revised?.markdown).toBe("# Revised\n\nWiki notes, round two.\n");
    expect(revised?.docVersion).toBe(3);

    await setEmbassyGrant(db, {
      id: intake.id,
      projectId: org.projectId,
      grant: "suggest",
    });
    const put3 = await SELF.fetch(`${ORIGIN}/s/${intake.id}`, {
      method: "PUT",
      headers: {
        "content-type": "text/markdown",
        "x-doc-version": "3",
      },
      body: "# Round three\n",
    });
    expect(put3.status).toBe(403);
    expect(await put3.text()).toContain("/suggest");
    const proposed = await SELF.fetch(`${ORIGIN}/s/${intake.id}/suggest`, {
      method: "POST",
      headers: {
        "content-type": "text/markdown",
        "x-doc-version": "3",
      },
      body: "# Round three\n",
    });
    expect(proposed.status).toBe(201);

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

  it("stops at the write limit even when requests race the stale count", async () => {
    const user = await signUp("em-limit");
    const org = await createOrg(user, "Limit Org");
    await seedDoc(org.projectId, "capped", "# Meeting\n\nHello.\n");
    const db = connectControlDb(env.DB);
    const link = await mintEmbassy(db, {
      projectId: org.projectId,
      documentSlug: docSlug("capped"),
      grant: "suggest",
    });
    await db
      .update(embassy)
      .set({ writeCount: EMBASSY_WRITE_LIMIT - 1 })
      .where(eq(embassy.id, link.id));

    const raced = await Promise.all(
      ["# one\n", "# two\n"].map((body) =>
        SELF.fetch(`${ORIGIN}/s/${link.id}/suggest`, {
          method: "POST",
          headers: {
            "content-type": "text/markdown",
            "x-doc-version": "1",
          },
          body,
        }),
      ),
    );
    expect(raced.map((r) => r.status).sort()).toEqual([201, 429]);
    const [row] = await db
      .select({ writeCount: embassy.writeCount })
      .from(embassy)
      .where(eq(embassy.id, link.id));
    expect(row?.writeCount).toBe(EMBASSY_WRITE_LIMIT);

    const blocked = await SELF.fetch(`${ORIGIN}/s/${link.id}/suggest`, {
      method: "POST",
      headers: {
        "content-type": "text/markdown",
        "x-doc-version": "1",
      },
      body: "# three\n",
    });
    expect(blocked.status).toBe(429);
    expect(
      await storeFor(env, org.projectId).listSuggestions(docSlug("capped")),
    ).toHaveLength(1);
  });

  it("releases a reserved slot when the write conflicts", async () => {
    const user = await signUp("em-release");
    const org = await createOrg(user, "Release Org");
    await seedDoc(org.projectId, "race", "# Meeting\n\nHello.\n");
    const db = connectControlDb(env.DB);
    const link = await mintEmbassy(db, {
      projectId: org.projectId,
      documentSlug: docSlug("race"),
      grant: "suggest",
    });
    await db
      .update(embassy)
      .set({ writeCount: EMBASSY_WRITE_LIMIT - 1 })
      .where(eq(embassy.id, link.id));

    const conflict = await SELF.fetch(`${ORIGIN}/s/${link.id}/suggest`, {
      method: "POST",
      headers: {
        "content-type": "text/markdown",
        "x-doc-version": "0",
      },
      body: "# proposed\n",
    });
    expect(conflict.status).toBe(409);
    const [afterConflict] = await db
      .select({ writeCount: embassy.writeCount })
      .from(embassy)
      .where(eq(embassy.id, link.id));
    expect(afterConflict?.writeCount).toBe(EMBASSY_WRITE_LIMIT - 1);

    const retry = await SELF.fetch(`${ORIGIN}/s/${link.id}/suggest`, {
      method: "POST",
      headers: {
        "content-type": "text/markdown",
        "x-doc-version": "1",
      },
      body: "# proposed\n",
    });
    expect(retry.status).toBe(201);
  });

  it("rejects a suggest against an archived document", async () => {
    const user = await signUp("em-arch");
    const org = await createOrg(user, "Archive Org");
    await seedDoc(org.projectId, "gone", "# Meeting\n\nHello.\n");
    const db = connectControlDb(env.DB);
    const link = await mintEmbassy(db, {
      projectId: org.projectId,
      documentSlug: docSlug("gone"),
      grant: "suggest",
    });
    await storeFor(env, org.projectId).archiveDocument(
      docSlug("gone"),
      "owner",
    );

    const suggest = await SELF.fetch(`${ORIGIN}/s/${link.id}/suggest`, {
      method: "POST",
      headers: {
        "content-type": "text/markdown",
        "x-doc-version": "1",
      },
      body: "# still here\n",
    });
    expect(suggest.status).toBe(404);
    expect(
      await storeFor(env, org.projectId).listSuggestions(docSlug("gone")),
    ).toHaveLength(0);
  });

  it("rejects an empty or invalid edit without writing", async () => {
    const user = await signUp("em-fill");
    const org = await createOrg(user, "Fill Org");
    await seedDoc(org.projectId, "blank", "");
    await seedDoc(org.projectId, "fenced", "");
    const db = connectControlDb(env.DB);
    const blank = await mintEmbassy(db, {
      projectId: org.projectId,
      documentSlug: docSlug("blank"),
      grant: "edit",
    });
    const fenced = await mintEmbassy(db, {
      projectId: org.projectId,
      documentSlug: docSlug("fenced"),
      grant: "edit",
    });

    const empty = await SELF.fetch(`${ORIGIN}/s/${blank.id}`, {
      method: "PUT",
      headers: {
        "content-type": "text/markdown",
        "x-doc-version": "1",
      },
      body: "",
    });
    expect(empty.status).toBe(400);
    const frontmatterOnly = await SELF.fetch(`${ORIGIN}/s/${blank.id}`, {
      method: "PUT",
      headers: {
        "content-type": "text/markdown",
        "x-doc-version": "1",
      },
      body: "---\ntitle: x\n---\n\n",
    });
    expect(frontmatterOnly.status).toBe(400);
    expect((await resolveLiveEmbassy(db, blank.id))?.writeCount).toBe(0);

    const filled = await SELF.fetch(`${ORIGIN}/s/${blank.id}`, {
      method: "PUT",
      headers: {
        "content-type": "text/markdown",
        "x-doc-version": "1",
      },
      body: "# Filled\n\nWiki notes.\n",
    });
    expect(filled.status).toBe(200);
    expect((await resolveLiveEmbassy(db, blank.id))?.writeCount).toBe(1);

    const badYaml = await SELF.fetch(`${ORIGIN}/s/${fenced.id}`, {
      method: "PUT",
      headers: {
        "content-type": "text/markdown",
        "x-doc-version": "1",
      },
      body: "---\n- not a mapping\n---\nFilled body.\n",
    });
    expect(badYaml.status).toBe(400);
    expect(await badYaml.text()).toContain("invalid YAML frontmatter");
    expect((await resolveLiveEmbassy(db, fenced.id))?.writeCount).toBe(0);
    const head = await storeFor(env, org.projectId).getDocument(
      docSlug("fenced"),
    );
    expect(head?.markdown).toBe("");
  });

  it("archived project kills live embassy links", async () => {
    const user = await signUp("em-dead");
    const org = await createOrg(user, "Dead Org");
    const db = connectControlDb(env.DB);
    const extra = await createProject(db, org.organizationId, "Scratch");
    await seedDoc(extra, "notes", "# hi\n");
    await seedDoc(extra, "blank", "");
    await seedDoc(org.projectId, "kept", "# stay\n");
    const read = await mintEmbassy(db, {
      projectId: extra,
      documentSlug: docSlug("notes"),
      grant: "read",
    });
    const suggest = await mintEmbassy(db, {
      projectId: extra,
      documentSlug: docSlug("notes"),
      grant: "suggest",
    });
    const fill = await mintEmbassy(db, {
      projectId: extra,
      documentSlug: docSlug("blank"),
      grant: "edit",
    });
    const kept = await mintEmbassy(db, {
      projectId: org.projectId,
      documentSlug: docSlug("kept"),
      grant: "suggest",
    });

    const live = await SELF.fetch(`${ORIGIN}/s/${read.id}`, {
      headers: { accept: "text/markdown" },
    });
    expect(live.status).toBe(200);

    await deleteProject(db, extra);

    const gone = await SELF.fetch(`${ORIGIN}/s/${read.id}`, {
      headers: { accept: "text/markdown" },
    });
    expect(gone.status).toBe(404);
    const suggestGone = await SELF.fetch(`${ORIGIN}/s/${suggest.id}/suggest`, {
      method: "POST",
      headers: {
        "content-type": "text/markdown",
        "x-doc-version": "1",
      },
      body: "# still here\n",
    });
    expect(suggestGone.status).toBe(404);
    const putGone = await SELF.fetch(`${ORIGIN}/s/${fill.id}`, {
      method: "PUT",
      headers: {
        "content-type": "text/markdown",
        "x-doc-version": "1",
      },
      body: "# Filled\n\nWiki notes.\n",
    });
    expect(putGone.status).toBe(404);
    expect(await resolveLiveEmbassy(db, read.id)).toBeUndefined();
    const [row] = await db
      .select({ revokedAt: embassy.revokedAt })
      .from(embassy)
      .where(eq(embassy.id, read.id));
    expect(row?.revokedAt).not.toBeNull();

    const still = await SELF.fetch(`${ORIGIN}/s/${kept.id}`, {
      headers: { accept: "text/markdown" },
    });
    expect(still.status).toBe(200);
  });

  it("broken project status fails closed without a revoke", async () => {
    const user = await signUp("em-broken");
    const org = await createOrg(user, "Broken Org");
    await seedDoc(org.projectId, "notes", "# hi\n");
    const db = connectControlDb(env.DB);
    const link = await mintEmbassy(db, {
      projectId: org.projectId,
      documentSlug: docSlug("notes"),
      grant: "suggest",
    });
    await markProjectBroken(db, org.projectId);

    const gone = await SELF.fetch(`${ORIGIN}/s/${link.id}`, {
      headers: { accept: "text/markdown" },
    });
    expect(gone.status).toBe(404);
    expect(await resolveLiveEmbassy(db, link.id)).toBeUndefined();
    const [row] = await db
      .select({ revokedAt: embassy.revokedAt })
      .from(embassy)
      .where(eq(embassy.id, link.id));
    expect(row?.revokedAt).toBeNull();
  });

  it("an edit link keeps writing after a member edits the page", async () => {
    const user = await signUp("em-owned");
    const org = await createOrg(user, "Owned Org");
    await seedDoc(org.projectId, "live", "# Meeting\n\nHello.\n");
    const db = connectControlDb(env.DB);
    const link = await mintEmbassy(db, {
      projectId: org.projectId,
      documentSlug: docSlug("live"),
      grant: "edit",
    });
    const saved = await storeFor(env, org.projectId).saveDocument({
      slug: docSlug("live"),
      markdown: "# Owner wrote\n",
      clientVersion: 1,
      changedBy: "owner",
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error("owner save failed");

    const stale = await SELF.fetch(`${ORIGIN}/s/${link.id}`, {
      method: "PUT",
      headers: {
        "content-type": "text/markdown",
        "x-doc-version": "1",
      },
      body: "# Agent draft\n",
    });
    expect(stale.status).toBe(409);

    const put = await SELF.fetch(`${ORIGIN}/s/${link.id}`, {
      method: "PUT",
      headers: {
        "content-type": "text/markdown",
        "x-doc-version": String(saved.docVersion),
      },
      body: "# Owner wrote\n\nAgent revision.\n",
    });
    expect(put.status).toBe(200);
    expect((await resolveLiveEmbassy(db, link.id))?.grant).toBe("edit");

    const suggest = await SELF.fetch(`${ORIGIN}/s/${link.id}/suggest`, {
      method: "POST",
      headers: {
        "content-type": "text/markdown",
        "x-doc-version": String(saved.docVersion + 1),
      },
      body: "# proposed\n",
    });
    expect(suggest.status).toBe(201);
  });

  it("releases an edit reservation when the save conflicts", async () => {
    const user = await signUp("em-revert");
    const org = await createOrg(user, "Revert Org");
    await seedDoc(org.projectId, "blank", "");
    const db = connectControlDb(env.DB);
    const link = await mintEmbassy(db, {
      projectId: org.projectId,
      documentSlug: docSlug("blank"),
      grant: "edit",
    });
    await db
      .update(embassy)
      .set({ writeCount: EMBASSY_WRITE_LIMIT - 1 })
      .where(eq(embassy.id, link.id));

    const conflict = await SELF.fetch(`${ORIGIN}/s/${link.id}`, {
      method: "PUT",
      headers: {
        "content-type": "text/markdown",
        "x-doc-version": "0",
      },
      body: "# Filled\n\nWiki notes.\n",
    });
    expect(conflict.status).toBe(409);
    const [after] = await db
      .select({ grant: embassy.grant, writeCount: embassy.writeCount })
      .from(embassy)
      .where(eq(embassy.id, link.id));
    expect(after?.grant).toBe("edit");
    expect(after?.writeCount).toBe(EMBASSY_WRITE_LIMIT - 1);

    const retry = await SELF.fetch(`${ORIGIN}/s/${link.id}`, {
      method: "PUT",
      headers: {
        "content-type": "text/markdown",
        "x-doc-version": "1",
      },
      body: "# Filled\n\nWiki notes.\n",
    });
    expect(retry.status).toBe(200);
    expect((await resolveLiveEmbassy(db, link.id))?.writeCount).toBe(
      EMBASSY_WRITE_LIMIT,
    );
  });
});
