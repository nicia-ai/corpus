import { describe, expect, it } from "vitest";

import { CliError, type CorpusConfig, type FetchLike } from "../cli/core";
import {
  type CloneAccess,
  cloneCommand,
  credentialReply,
  fetchCloneAccess,
  isCredentialOperation,
  parseCredentialRequest,
  shellQuote,
  tokenSecret,
} from "../cli/git";

const EXPIRES_AT = "2026-11-20T19:00:00.000Z";
const EXPIRES_UNIX = Date.parse(EXPIRES_AT) / 1000;

const ACCESS: CloneAccess = {
  remote: "https://acct.artifacts.cloudflare.net/git/prod/p1.handbook.git",
  branch: "main",
  token: "art_v1_secret123?expires=1795201200",
  expiresAt: EXPIRES_AT,
  current: true,
  corpus: "handbook",
};

type Call = Readonly<{ url: string; method: string | undefined }>;

function configReturning(
  status: number,
  body: unknown,
): Readonly<{ cfg: CorpusConfig; calls: Call[] }> {
  const calls: Call[] = [];
  const fetch: FetchLike = (input, init) => {
    calls.push({ url: input, method: init?.method });
    return Promise.resolve(Response.json(body, { status }));
  };
  return {
    cfg: {
      baseUrl: "https://corpus.example",
      apiKey: "cck_key",
      fetch,
      files: {
        readText: () => Promise.resolve(undefined),
        writeText: () => Promise.resolve(),
      },
    },
    calls,
  };
}

describe("fetchCloneAccess", () => {
  it("exchanges the key at the token endpoint and returns the access", async () => {
    const { cfg, calls } = configReturning(200, ACCESS);
    expect(await fetchCloneAccess(cfg)).toEqual(ACCESS);
    expect(calls).toEqual([
      { url: "https://corpus.example/api/v1/git/token", method: "POST" },
    ]);
  });

  it("explains a server with no mirror", async () => {
    const { cfg } = configReturning(404, { error: "not enabled here" });
    await expect(fetchCloneAccess(cfg)).rejects.toMatchObject({
      kind: "unsupported",
      message: "not enabled here",
    });
  });

  it("tells the caller when the mirror is not ready yet", async () => {
    const { cfg } = configReturning(409, { error: "not ready yet" });
    const error = await fetchCloneAccess(cfg).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ kind: "conflict", message: "not ready yet" });
  });

  it("reports any other failure as http with the status", async () => {
    const { cfg } = configReturning(500, {});
    await expect(fetchCloneAccess(cfg)).rejects.toMatchObject({
      kind: "http",
      detail: { status: 500 },
    });
  });
});

describe("cloneCommand", () => {
  it("carries the token as an http.extraHeader and sets up the helper for pulls", () => {
    expect(cloneCommand(ACCESS, { helper: false })).toBe(
      `git -c http.extraHeader='Authorization: Bearer art_v1_secret123?expires=1795201200' clone '${ACCESS.remote}' 'handbook'` +
        ` && git -C 'handbook' config credential.helper '!corpus git credential'`,
    );
  });

  it("keeps the token out of the command in helper mode", () => {
    const command = cloneCommand(ACCESS, { helper: true });
    expect(command).toBe(
      `git clone -c credential.helper='!corpus git credential' '${ACCESS.remote}' 'handbook'`,
    );
    expect(command).not.toContain("art_v1_secret123");
  });

  it("clones into the directory asked for", () => {
    expect(cloneCommand(ACCESS, { dir: "../ctx/hb", helper: true })).toContain(
      "'../ctx/hb'",
    );
  });

  it("quotes a value that could break out of the command", () => {
    expect(shellQuote("it's $(bad)")).toBe(`'it'\\''s $(bad)'`);
    expect(
      cloneCommand(ACCESS, { dir: "x'; rm -rf ~; '", helper: true }),
    ).toContain(`'x'\\''; rm -rf ~; '\\'''`);
  });
});

describe("tokenSecret", () => {
  it("drops the expiry suffix Basic auth must not carry", () => {
    expect(tokenSecret("secret?expires=123")).toBe("secret");
    expect(tokenSecret("secret")).toBe("secret");
  });
});

describe("the credential helper", () => {
  const asked = (host: string, protocol = "https"): string =>
    `protocol=${protocol}\nhost=${host}\npath=git/prod/p1.handbook.git\n\n`;

  it("parses git's key=value request", () => {
    expect(parseCredentialRequest("protocol=https\nhost=h:1\n\n")).toEqual(
      new Map([
        ["protocol", "https"],
        ["host", "h:1"],
      ]),
    );
  });

  it("answers `get` for the mirror's own host with a fresh token's secret", async () => {
    const { cfg } = configReturning(200, ACCESS);
    const reply = await credentialReply(
      cfg,
      "get",
      asked("acct.artifacts.cloudflare.net"),
    );
    expect(reply).toBe(
      `username=x\npassword=art_v1_secret123\npassword_expiry_utc=${String(EXPIRES_UNIX)}\n`,
    );
  });

  it("never offers the token to another host or scheme", async () => {
    const { cfg } = configReturning(200, ACCESS);
    expect(await credentialReply(cfg, "get", asked("github.com"))).toBe("");
    expect(
      await credentialReply(
        cfg,
        "get",
        asked("acct.artifacts.cloudflare.net", "http"),
      ),
    ).toBe("");
  });

  it("does nothing for store and erase, without calling the server", async () => {
    const { cfg, calls } = configReturning(200, ACCESS);
    expect(await credentialReply(cfg, "store", asked("a"))).toBe("");
    expect(await credentialReply(cfg, "erase", asked("a"))).toBe("");
    expect(calls).toEqual([]);
  });

  it("only recognises git's three operations", () => {
    expect(["get", "store", "erase"].every(isCredentialOperation)).toBe(true);
    expect(isCredentialOperation("list")).toBe(false);
    expect(isCredentialOperation(undefined)).toBe(false);
  });
});
