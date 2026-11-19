import { env, SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { connectControlDb } from "../src/control/db";
import {
  mintEmbassy,
  revokeEmbassy,
  setEmbassyExpiry,
  type EmbassyView,
} from "../src/control/embassies";
import { embassy } from "../src/control/schema/app";
import { storeFor } from "../src/control/store-for";
import { resolveAuthorLabels, resolveUserNames } from "../src/control/users";
import {
  embassyExpiresAt,
  EMBASSY_NEVER_EXPIRES_AT,
  neverExpires,
} from "../src/embassy/expiry";
import { embassyPrompt } from "../src/embassy/prompt";
import { callerRefFromEmbassy } from "../src/ids";

import {
  colSlug,
  createCorpusFor,
  createOrg,
  docSlug,
  signUp,
} from "./_helpers";

const ORIGIN = "https://example.com";

const HACKATHON = [
  "# Hackathon",
  "",
  "## Guidelines",
  "",
  "TBD",
  "",
  "## Location",
  "",
  "TBD",
  "",
  "## Participants",
  "",
  "- Ada",
  "",
].join("\n");

type Fixture = Readonly<{
  projectId: Awaited<ReturnType<typeof createOrg>>["projectId"];
  slug: ReturnType<typeof docSlug>;
  link: (
    label: string,
    grant?: "read" | "suggest" | "edit",
  ) => Promise<EmbassyView>;
}>;

async function fixture(
  salt: string,
  markdown: string = HACKATHON,
): Promise<Fixture> {
  const user = await signUp(`es-${salt}`);
  const org = await createOrg(user, `Section Org ${salt}`);
  const slug = docSlug(`hackathon-${salt}`);
  const saved = await storeFor(env, org.projectId).saveDocument({
    slug,
    title: "Hackathon",
    markdown,
    clientVersion: 0,
    changedBy: "owner",
  });
  expect(saved.ok).toBe(true);
  return {
    projectId: org.projectId,
    slug,
    link: (label, grant = "edit") =>
      mintEmbassy(connectControlDb(env.DB), {
        projectId: org.projectId,
        documentSlug: slug,
        label,
        grant,
      }),
  };
}

function putSection(
  link: EmbassyView,
  heading: string | undefined,
  body: string,
  version: number | string | undefined,
  extra = "",
): Promise<Response> {
  const query =
    heading === undefined
      ? ""
      : `?heading=${encodeURIComponent(heading)}${extra}`;
  return SELF.fetch(`${ORIGIN}/s/${link.id}/section${query}`, {
    method: "PUT",
    headers: {
      "content-type": "text/markdown",
      ...(version === undefined ? {} : { "x-doc-version": String(version) }),
    },
    body,
  });
}

async function head(
  f: Fixture,
): Promise<{ markdown: string; docVersion: number }> {
  const doc = await storeFor(env, f.projectId).getDocument(f.slug);
  if (doc === undefined) throw new Error("document missing");
  return doc;
}

async function writeCount(link: EmbassyView): Promise<number> {
  const [row] = await connectControlDb(env.DB)
    .select({ n: embassy.writeCount })
    .from(embassy)
    .where(eq(embassy.id, link.id));
  return row?.n ?? -1;
}

describe("PUT /s/:token/section", () => {
  it("replaces one section and preserves every other byte", async () => {
    const f = await fixture("replace");
    const link = await f.link("Dana's Claude");
    const res = await putSection(link, "Location", "Pier 9, Friday 6pm", 1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      docVersion: 2,
      created: false,
    });
    expect((await head(f)).markdown).toBe(
      HACKATHON.replace(
        "## Location\n\nTBD\n",
        "## Location\n\nPier 9, Friday 6pm\n",
      ),
    );
  });

  it("creates a missing section at the end, at the requested level", async () => {
    const f = await fixture("create");
    const link = await f.link("Dana's Claude");
    const res = await putSection(link, "Schedule", "Friday 6pm", 1, "&level=3");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      docVersion: 2,
      created: true,
    });
    expect((await head(f)).markdown).toBe(
      `${HACKATHON}\n### Schedule\n\nFriday 6pm\n`,
    );
  });

  it("is a single transaction: one new version, authored by the link", async () => {
    const f = await fixture("version");
    const link = await f.link("Dana's Claude");
    await putSection(link, "Guidelines", "Be kind.", 1);
    const store = storeFor(env, f.projectId);
    const v2 = await store.documentHistoryVersion(f.slug, 2);
    expect(v2?.changedBy).toBe(callerRefFromEmbassy(link.id));
    expect(await store.documentHistoryVersion(f.slug, 3)).toBeUndefined();
  });

  it("two links writing different sections back to back both land", async () => {
    const f = await fixture("two");
    const eng = await f.link("Eng guidelines agent");
    const ops = await f.link("Event details agent");
    // Both agents fetched version 1.
    const first = await putSection(eng, "Guidelines", "- Keep PRs small", 1);
    expect(first.status).toBe(200);
    const second = await putSection(ops, "Location", "Pier 9", 1);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      ok: true,
      docVersion: 3,
      created: false,
    });
    const { markdown } = await head(f);
    expect(markdown).toContain("## Guidelines\n\n- Keep PRs small\n");
    expect(markdown).toContain("## Location\n\nPier 9\n");
    expect(markdown).toContain("## Participants\n\n- Ada\n");

    const store = storeFor(env, f.projectId);
    expect((await store.documentHistoryVersion(f.slug, 2))?.changedBy).toBe(
      callerRefFromEmbassy(eng.id),
    );
    expect((await store.documentHistoryVersion(f.slug, 3))?.changedBy).toBe(
      callerRefFromEmbassy(ops.id),
    );
  });

  it("an agent can keep updating its section across many versions", async () => {
    const f = await fixture("rsvp");
    const ops = await f.link("Event details agent");
    let version = 1;
    const names = ["Ada"];
    for (const name of ["Grace", "Linus", "Margaret"]) {
      names.push(name);
      const res = await putSection(
        ops,
        "Participants",
        names.map((n) => `- ${n}`).join("\n"),
        version,
      );
      expect(res.status).toBe(200);
      version = (await head(f)).docVersion;
    }
    expect(version).toBe(4);
    expect((await head(f)).markdown).toBe(
      HACKATHON.replace("- Ada\n", "- Ada\n- Grace\n- Linus\n- Margaret\n"),
    );
  });

  it("409s when the target section changed since the agent's read", async () => {
    const f = await fixture("stale");
    const a = await f.link("Agent A");
    const b = await f.link("Agent B");
    expect((await putSection(a, "Location", "Pier 9", 1)).status).toBe(200);
    const clash = await putSection(b, "Location", "Dock 4", 1);
    expect(clash.status).toBe(409);
    expect(await clash.json()).toEqual({
      ok: false,
      conflict: true,
      currentVersion: 2,
    });
    expect((await head(f)).markdown).toContain("Pier 9");
    expect((await head(f)).markdown).not.toContain("Dock 4");
    expect(await writeCount(b)).toBe(0);
  });

  it("409s for a section created by someone else since the agent's read", async () => {
    const f = await fixture("created-race");
    const a = await f.link("Agent A");
    const b = await f.link("Agent B");
    expect((await putSection(a, "Schedule", "Fri", 1)).status).toBe(200);
    expect((await putSection(b, "Schedule", "Sat", 1)).status).toBe(409);
  });

  it("409s on a version ahead of the head, like the whole-page PUT", async () => {
    const f = await fixture("ahead");
    const link = await f.link("Agent");
    expect((await putSection(link, "Location", "x", 9)).status).toBe(409);
  });

  it("requires the version header and a heading", async () => {
    const f = await fixture("required");
    const link = await f.link("Agent");
    expect((await putSection(link, "Location", "x", undefined)).status).toBe(
      400,
    );
    expect((await putSection(link, undefined, "x", 1)).status).toBe(400);
    expect(
      (await putSection(link, "Location", "x", 1, "&level=9")).status,
    ).toBe(400);
    expect(await writeCount(link)).toBe(0);
  });

  it("refuses read and suggest grants with the existing 403 guidance", async () => {
    const f = await fixture("grants");
    const read = await f.link("Reader", "read");
    const suggest = await f.link("Suggester", "suggest");
    expect((await putSection(read, "Location", "x", 1)).status).toBe(403);
    const res = await putSection(suggest, "Location", "x", 1);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("/suggest");
    expect((await head(f)).docVersion).toBe(1);
  });

  it("stops working when the owner switches the link to suggest or revokes it", async () => {
    const f = await fixture("revoked");
    const link = await f.link("Agent");
    await connectControlDb(env.DB)
      .update(embassy)
      .set({ grant: "suggest" })
      .where(eq(embassy.id, link.id));
    expect((await putSection(link, "Location", "x", 1)).status).toBe(403);
    await connectControlDb(env.DB)
      .update(embassy)
      .set({ grant: "edit" })
      .where(eq(embassy.id, link.id));
    await revokeEmbassy(connectControlDb(env.DB), {
      id: link.id,
      projectId: f.projectId,
    });
    expect((await putSection(link, "Location", "x", 1)).status).toBe(404);
  });

  it("422s on duplicate headings and tells the agent how to disambiguate", async () => {
    const f = await fixture(
      "dupes",
      "## Notes\n\na\n\n## Notes\n\nb\n\n### Notes\n\nc\n",
    );
    const link = await f.link("Agent");
    const res = await putSection(link, "Notes", "x", 1);
    expect(res.status).toBe(422);
    const message = await res.text();
    expect(message).toContain("matches 3 sections");
    expect(message).toContain("level 2 at line 1");
    expect(message).toContain("level=N");
    expect(await writeCount(link)).toBe(0);
    expect((await putSection(link, "Notes", "x", 1, "&level=3")).status).toBe(
      200,
    );
    expect((await putSection(link, "Notes", "x", 2, "&level=2")).status).toBe(
      422,
    );
  });

  it("422s on a body that would split the section", async () => {
    const f = await fixture("split");
    const link = await f.link("Agent");
    const res = await putSection(link, "Location", "x\n\n## Extra\n\ny", 1);
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("deeper headings");
    expect((await head(f)).docVersion).toBe(1);
  });

  it("413s on an oversized body", async () => {
    const f = await fixture("big");
    const link = await f.link("Agent");
    const res = await putSection(
      link,
      "Location",
      "x".repeat(2 * 1024 * 1024),
      1,
    );
    expect(res.status).toBe(413);
  });

  it("403s once the page is served by a corpus", async () => {
    const f = await fixture("served");
    const link = await f.link("Agent");
    await createCorpusFor(f.projectId, colSlug("published"));
    await storeFor(env, f.projectId).attachDocument(
      colSlug("published"),
      f.slug,
      1,
      "owner",
    );
    const res = await putSection(link, "Location", "x", 1);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("/suggest");
  });
});

describe("prompt", () => {
  it("teaches the section write to edit links only, and durable instructions to all", () => {
    const url = `${ORIGIN}/s/abc`;
    const edit = embassyPrompt({ url, grant: "edit" });
    expect(edit).toContain(`PUT ${url}/section?heading=`);
    expect(edit).toContain(`PUT ${url}\n`);
    expect(edit).toContain("CLAUDE.md");
    const suggest = embassyPrompt({ url, grant: "suggest" });
    expect(suggest).not.toContain("/section");
    expect(suggest).toContain("CLAUDE.md");
    expect(embassyPrompt({ url, grant: "read" })).toContain("CLAUDE.md");
  });
});

describe("attribution", () => {
  it("shows the link name, not the raw ref, wherever authors resolve", async () => {
    const f = await fixture("labels");
    const link = await f.link("Dana's Claude Code");
    const ref = callerRefFromEmbassy(link.id);
    const db = connectControlDb(env.DB);
    expect((await resolveUserNames(db, [ref])).get(ref)).toBe(
      "Dana's Claude Code",
    );
    expect((await resolveAuthorLabels(db, [ref])).get(ref)).toBe(
      "Dana's Claude Code",
    );
  });

  it("keeps the name after the link is revoked, and falls back for a missing row", async () => {
    const f = await fixture("labels-revoked");
    const link = await f.link("Event details agent");
    const db = connectControlDb(env.DB);
    await revokeEmbassy(db, { id: link.id, projectId: f.projectId });
    const ref = callerRefFromEmbassy(link.id);
    expect((await resolveUserNames(db, [ref])).get(ref)).toBe(
      "Event details agent",
    );
    const ghost = "embassy:00000000-0000-0000-0000-000000000000";
    expect((await resolveUserNames(db, [ghost])).get(ghost)).toBe(
      "Shared agent",
    );
  });
});

describe("link expiry", () => {
  it("extends a live link, never revives a revoked one", async () => {
    const f = await fixture("expiry");
    const link = await f.link("Agent");
    const db = connectControlDb(env.DB);
    const extended = await setEmbassyExpiry(db, {
      id: link.id,
      projectId: f.projectId,
      expiresAt: EMBASSY_NEVER_EXPIRES_AT,
    });
    expect(extended).toBeDefined();
    expect(neverExpires(extended?.expiresAt ?? 0)).toBe(true);
    expect((await putSection(link, "Location", "x", 1)).status).toBe(200);

    await revokeEmbassy(db, { id: link.id, projectId: f.projectId });
    expect(
      await setEmbassyExpiry(db, {
        id: link.id,
        projectId: f.projectId,
        expiresAt: embassyExpiresAt("90d", Date.now()),
      }),
    ).toBeUndefined();
  });

  it("is scoped to the owning project", async () => {
    const mine = await fixture("expiry-a");
    const theirs = await fixture("expiry-b");
    const link = await mine.link("Agent");
    expect(
      await setEmbassyExpiry(connectControlDb(env.DB), {
        id: link.id,
        projectId: theirs.projectId,
        expiresAt: EMBASSY_NEVER_EXPIRES_AT,
      }),
    ).toBeUndefined();
  });

  it("computes day-based and unbounded expiries", () => {
    const now = Date.UTC(2026, 0, 1);
    expect(embassyExpiresAt("7d", now)).toBe(now + 7 * 86_400_000);
    expect(embassyExpiresAt("30d", now)).toBe(now + 30 * 86_400_000);
    expect(neverExpires(embassyExpiresAt("never", now))).toBe(true);
    expect(neverExpires(embassyExpiresAt("90d", now))).toBe(false);
  });
});
