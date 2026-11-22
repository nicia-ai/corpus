import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { reconcileRetention } from "../src/control/project-reconciliation";
import { FILES_NOT_ENABLED_MESSAGE } from "../src/files/object-store-for";

import { newCorpus } from "./_cli-fixtures";
import { createOrg, signUpSession } from "./_helpers";

// File storage is optional, exactly like the Git mirror. The default wrangler
// config (this project) has no `FILES` R2 binding, which is every self-hoster
// who has not created a bucket: the feature is off, and "off" must be free: a
// clear answer where it would be, no error anywhere else.

const ORIGIN = "https://example.com";

describe("without the FILES binding", () => {
  it("has no binding", () => {
    expect(env.FILES).toBeUndefined();
  });

  it("answers an upload with a clear 'not enabled', not an error", async () => {
    const session = await signUpSession("nofiles");
    const org = await createOrg(session.userId, "No Files");
    const res = await SELF.fetch(
      `${ORIGIN}/api/files?project=${org.projectId}&document=x`,
      {
        method: "PUT",
        headers: {
          cookie: session.headers.get("cookie") ?? "",
          origin: ORIGIN,
        },
        body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: FILES_NOT_ENABLED_MESSAGE });
  });

  it("answers a read the same way", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/files/p/${"a".repeat(64)}`);
    expect(res.status).toBe(404);
  });

  it("answers the key-authenticated file routes 'not enabled', which a sync reads as 'not carried'", async () => {
    const corpus = await newCorpus("edit");
    const authorization = { authorization: `Bearer ${corpus.token}` };
    const replies = await Promise.all([
      SELF.fetch(`${ORIGIN}/api/v1/files`, { headers: authorization }),
      SELF.fetch(`${ORIGIN}/api/v1/files?path=a.png`, {
        method: "PUT",
        headers: authorization,
        body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      }),
    ]);
    for (const res of replies) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: FILES_NOT_ENABLED_MESSAGE,
        code: "files_not_enabled",
      });
    }
  });

  it("runs the retention sweep without touching storage", async () => {
    const session = await signUpSession("sweep-off");
    await createOrg(session.userId, "Sweep Off");
    await expect(reconcileRetention(env)).resolves.toBeGreaterThanOrEqual(0);
  });
});
