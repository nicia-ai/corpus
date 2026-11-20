import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { CorpusConfig, FetchLike } from "../../cli/core";
import {
  cloneCommand,
  credentialReply,
  fetchCloneAccess,
  tokenSecret,
} from "../../cli/git";

import { BASE_URL, newFixture, put, settle } from "./_support";

// The CLI against the real endpoint and the local Artifacts simulator.

async function cliConfig(): Promise<
  Readonly<{ cfg: CorpusConfig; corpusSlug: string }>
> {
  const fixture = await newFixture();
  await put(fixture, "a.md", "# A\n");
  await settle(fixture);
  const fetch: FetchLike = (input, init) => SELF.fetch(input, init);
  return {
    corpusSlug: fixture.corpusSlug,
    cfg: {
      baseUrl: BASE_URL,
      apiKey: fixture.token,
      fetch,
      files: {
        readText: () => Promise.resolve(undefined),
        writeText: () => Promise.resolve(),
      },
    },
  };
}

describe("corpus git against the server", () => {
  it("prints a clone command for the key's own corpus", async () => {
    const { cfg, corpusSlug } = await cliConfig();
    const access = await fetchCloneAccess(cfg);
    expect(access.corpus).toBe(corpusSlug);
    const command = cloneCommand(access, { helper: false });
    expect(command).toContain(`clone '${access.remote}' '${corpusSlug}'`);
    expect(command).toContain(`Authorization: Bearer ${access.token}`);
  });

  it("serves git's credential request for the mirror host", async () => {
    const { cfg } = await cliConfig();
    const access = await fetchCloneAccess(cfg);
    const mirror = new URL(access.remote);
    const reply = await credentialReply(
      cfg,
      "get",
      `protocol=${mirror.protocol.replace(":", "")}\nhost=${mirror.host}\n\n`,
    );
    expect(reply).toContain("username=x\n");
    // A fresh token every time, never the one `fetchCloneAccess` returned.
    expect(reply).toMatch(/\npassword=\S+\n/u);
    expect(reply).not.toContain(tokenSecret(access.token));
    expect(reply).toContain("password_expiry_utc=");
  });
});
