import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { setGitMirrorForTest } from "../../src/mirror/mirror-for";
import {
  CLONE_TOKEN_TTL_SECONDS,
  MIRROR_BRANCH,
} from "../../src/store/domain/git-mirror";

import { BASE_URL, newFixture, postCloneToken, put, settle } from "./_support";

const AccessBody = z.object({
  remote: z.string(),
  branch: z.string(),
  token: z.string(),
  expiresAt: z.string(),
  current: z.boolean(),
});

const ErrorBody = z.object({ error: z.string() });

afterEach(() => {
  setGitMirrorForTest(undefined);
});

async function ready(): Promise<Awaited<ReturnType<typeof newFixture>>> {
  const fixture = await newFixture();
  await put(fixture, "a.md", "# A\n");
  await settle(fixture);
  return fixture;
}

// What the Git endpoint answers a bearer token with, for a given service.
function gitInfoRefs(
  remote: string,
  service: "git-upload-pack" | "git-receive-pack",
  token: string,
): Promise<Response> {
  return fetch(`${remote}/info/refs?service=${service}`, {
    headers: { authorization: `Bearer ${token}`, "user-agent": "git/2.45.0" },
  });
}

describe("POST /api/v1/git/token", () => {
  it("exchanges an API key for a short-lived read token", async () => {
    const fixture = await ready();
    const response = await postCloneToken(fixture.token);
    expect(response.status).toBe(200);
    const body = AccessBody.parse(await response.json());

    expect(body.branch).toBe(MIRROR_BRANCH);
    expect(body.remote).toContain(fixture.repoName);
    expect(body.current).toBe(true);
    const lifetimeMs = Date.parse(body.expiresAt) - Date.now();
    expect(lifetimeMs).toBeGreaterThan((CLONE_TOKEN_TTL_SECONDS - 60) * 1000);
    expect(lifetimeMs).toBeLessThanOrEqual(CLONE_TOKEN_TTL_SECONDS * 1000);
  });

  it("hands out a credential that can read but never write", async () => {
    const fixture = await ready();
    const body = AccessBody.parse(
      await (await postCloneToken(fixture.token)).json(),
    );

    const read = await gitInfoRefs(body.remote, "git-upload-pack", body.token);
    expect(read.status).toBe(200);
    const write = await gitInfoRefs(
      body.remote,
      "git-receive-pack",
      body.token,
    );
    expect(write.ok).toBe(false);
  });

  it("is scoped to the key's own corpus", async () => {
    const one = await ready();
    const two = await ready();
    const first = AccessBody.parse(
      await (await postCloneToken(one.token)).json(),
    );
    const second = AccessBody.parse(
      await (await postCloneToken(two.token)).json(),
    );
    expect(first.remote).toContain(one.repoName);
    expect(first.remote).not.toContain(two.repoName);
    expect(second.remote).toContain(two.repoName);
    // One corpus's token does not open the other's repository.
    const cross = await gitInfoRefs(
      second.remote,
      "git-upload-pack",
      first.token,
    );
    expect(cross.ok).toBe(false);
  });

  it("leaves no usable write credential behind after a sync", async () => {
    const fixture = await ready();
    using repo = await (env.ARTIFACTS as Artifacts).get(fixture.repoName);
    const { tokens } = await repo.listTokens();
    const usableWriters = tokens.filter(
      (t) => t.scope === "write" && t.state === "active",
    );
    expect(usableWriters).toEqual([]);
  });

  it("answers 409 until the first push has landed", async () => {
    const fixture = await newFixture();
    setGitMirrorForTest({
      inspect: () => Promise.reject(new Error("artifacts is down")),
      create: () => Promise.reject(new Error("artifacts is down")),
      commit: () => Promise.reject(new Error("artifacts is down")),
      discard: () => Promise.reject(new Error("artifacts is down")),
      cloneAccess: () => Promise.reject(new Error("artifacts is down")),
    });
    await put(fixture, "a.md", "# A\n");
    await settle(fixture);

    const response = await postCloneToken(fixture.token);
    expect(response.status).toBe(409);
    expect(ErrorBody.parse(await response.json()).error).toContain("not ready");
  });

  it("rejects a missing, malformed or unknown key", async () => {
    await ready();
    expect(
      (await SELF.fetch(`${BASE_URL}/api/v1/git/token`, { method: "POST" }))
        .status,
    ).toBe(401);
    expect((await postCloneToken("not-a-key")).status).toBe(401);
    expect((await postCloneToken("cck_unknown")).status).toBe(401);
  });

  it("flags a clone that is behind the corpus", async () => {
    const fixture = await ready();
    setGitMirrorForTest({
      inspect: () => Promise.reject(new Error("artifacts is down")),
      create: () => Promise.reject(new Error("artifacts is down")),
      commit: () => Promise.reject(new Error("artifacts is down")),
      discard: () => Promise.reject(new Error("artifacts is down")),
      cloneAccess: () => Promise.reject(new Error("artifacts is down")),
    });
    await put(fixture, "a.md", "# A, changed\n");
    await settle(fixture);
    setGitMirrorForTest(undefined);

    const body = AccessBody.parse(
      await (await postCloneToken(fixture.token)).json(),
    );
    expect(body.current).toBe(false);
  });
});
