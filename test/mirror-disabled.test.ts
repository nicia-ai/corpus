import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { MIRROR_NOT_ENABLED_MESSAGE } from "../src/mirror/errors";

import { mirrorRows, newFixture, postCloneToken, put } from "./mirror/_support";

// The Artifacts binding is optional. This project (the default wrangler
// config) has none, which is every self-hoster on a plan without Artifacts:
// the feature is off, and "off" must be free — no records piling up, no
// network, a clear answer where the feature would be.

const ErrorBody = z.object({ error: z.string() });

describe("without the Artifacts binding", () => {
  it("has no binding", () => {
    expect(env.ARTIFACTS).toBeUndefined();
  });

  it("keeps no mirror records however much changes", async () => {
    const fixture = await newFixture();
    for (let i = 0; i < 5; i += 1) {
      await put(fixture, `docs/file-${String(i)}.md`, `# ${String(i)}\n`);
    }
    await put(fixture, "docs/file-0.md", "# edited\n");
    await fixture.store.drainGitMirror();

    expect(await mirrorRows(fixture)).toEqual([]);
  });

  it("schedules no alarm", async () => {
    const fixture = await newFixture();
    await put(fixture, "a.md", "# A\n");
    // The event-stream outbox may use the alarm; the mirror must not.
    const alarm = await runInDurableObject(fixture.store, (_i, state) =>
      state.storage.getAlarm(),
    );
    expect(alarm).toBeNull();
  });

  it("reports the mirror as off", async () => {
    const fixture = await newFixture();
    await put(fixture, "a.md", "# A\n");
    expect(await fixture.store.gitMirrorStatus(fixture.corpusSlug)).toEqual({
      enabled: false,
    });
  });

  it("refuses a rebuild and a clone credential, clearly", async () => {
    const fixture = await newFixture();
    await put(fixture, "a.md", "# A\n");
    expect(
      await fixture.store.rebuildGitMirror(
        fixture.corpusSlug,
        fixture.ownerUserId,
      ),
    ).toEqual({ ok: false, reason: "not-enabled" });
    expect(await fixture.store.gitCloneAccess(fixture.corpusSlug)).toEqual({
      ok: false,
      reason: "not-enabled",
    });
  });

  it("answers the clone endpoint with a clear 'not enabled'", async () => {
    const fixture = await newFixture();
    await put(fixture, "a.md", "# A\n");
    const response = await postCloneToken(fixture.token);
    expect(response.status).toBe(404);
    expect(ErrorBody.parse(await response.json()).error).toBe(
      MIRROR_NOT_ENABLED_MESSAGE,
    );
  });
});
