import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { connectControlDb } from "../src/control/db";
import { apiKey } from "../src/control/schema/app";
import { resolveAuthorLabels } from "../src/control/users";

import {
  createConnection,
  createOrg,
  docSlug,
  freshStore,
  signUp,
} from "./_helpers";

// Seed a user + an api key they own, so an `apikey:<id>` author can be
// resolved back to the human via api_key.userId.
async function seedKeyOwner(): Promise<{ userId: string; apiKeyId: string }> {
  const userId = await signUp("aa-key");
  const org = await createOrg(userId, "Author Attribution Org");
  const conn = await createConnection({
    organizationId: org.organizationId,
    projectId: org.projectId,
  });
  const db = connectControlDb(env.DB);
  const [row] = await db
    .insert(apiKey)
    .values({
      userId,
      organizationId: org.organizationId,
      connectionId: conn.connectionId,
      name: "CI key",
      tokenHash: `hash-${userId}`,
      tokenPrefix: "cck_test",
    })
    .returning({ id: apiKey.id });
  return { userId, apiKeyId: row?.id ?? "" };
}

describe("resolveAuthorLabels (control plane)", () => {
  it("resolves a bare user id, an oauth ref, and an apikey ref all to the same human", async () => {
    const { userId, apiKeyId } = await seedKeyOwner();
    const db = connectControlDb(env.DB);
    const out = await resolveAuthorLabels(db, [
      userId,
      `oauth:${userId}`,
      `oauth:${userId}:connection:conn-1`,
      `apikey:${apiKeyId}`,
    ]);
    const name = out.get(userId);
    expect(name).toBeDefined();
    // oauth:<sub> IS the user id; apikey:<id> hops api_key.userId to the owner.
    expect(out.get(`oauth:${userId}`)).toBe(name);
    expect(out.get(`oauth:${userId}:connection:conn-1`)).toBe(name);
    expect(out.get(`apikey:${apiKeyId}`)).toBe(name);
  });

  it("falls back to a key label for an unknown api key and NEVER leaks the oauth: prefix for an unknown user", async () => {
    const db = connectControlDb(env.DB);
    const out = await resolveAuthorLabels(db, [
      "apikey:does-not-exist",
      "oauth:ghost-user",
    ]);
    expect(out.get("apikey:does-not-exist")).toBe("API key");
    const ghost = out.get("oauth:ghost-user");
    expect(ghost).toBe("ghost-user"); // bare id, prefix stripped
    expect(ghost).not.toContain("oauth:"); // the raw-ref leak this guards against
  });
});

describe("openSuggestionCounts (DO + D1)", () => {
  const BASE = "alpha\n\nbeta\n\ngamma";

  it("counts only OPEN suggestions per document; a resolved one drops out", async () => {
    const store = freshStore("aa-count");
    const a = docSlug("doc-a");
    const b = docSlug("doc-b");
    await store.saveDocument({
      slug: a,
      markdown: BASE,
      clientVersion: 0,
      changedBy: "u",
    });
    await store.saveDocument({
      slug: b,
      markdown: BASE,
      clientVersion: 0,
      changedBy: "u",
    });

    const s1 = await store.createSuggestion({
      slug: a,
      proposedMarkdown: `${BASE}\n\ndelta`,
      clientVersion: 1,
      createdBy: "u",
      channel: "web",
    });
    await store.createSuggestion({
      slug: a,
      proposedMarkdown: `${BASE}\n\nepsilon`,
      clientVersion: 1,
      createdBy: "u",
      channel: "web",
    });
    await store.createSuggestion({
      slug: b,
      proposedMarkdown: `${BASE}\n\nzeta`,
      clientVersion: 1,
      createdBy: "u",
      channel: "web",
    });

    expect(await store.openSuggestionCounts()).toEqual({
      "doc-a": 2,
      "doc-b": 1,
    });

    if (!s1.ok) throw new Error("seed suggestion failed");
    await store.rejectSuggestion({
      suggestionId: s1.suggestionId,
      rejectedBy: "u",
    });

    // The rejected suggestion no longer counts; a doc with none is absent
    // (callers default to 0).
    expect(await store.openSuggestionCounts()).toEqual({
      "doc-a": 1,
      "doc-b": 1,
    });
  });
});
