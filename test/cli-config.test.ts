import { describe, expect, it } from "vitest";

import {
  normalizeBaseUrl,
  parseSavedConfig,
  resolveConfig,
  savedConfig,
  serializeSavedConfig,
} from "../cli/config";
import { corpusConfigPath } from "../cli/config-path";
import { doctor, push } from "../cli/core";

describe("CLI saved configuration", () => {
  it("normalizes a URL and round-trips the stored JSON", () => {
    const config = savedConfig({
      baseUrl: " https://corpus.example.com/ ",
      apiKey: " cck_secret ",
    });
    expect(config).toEqual({
      baseUrl: "https://corpus.example.com",
      apiKey: "cck_secret",
    });
    expect(parseSavedConfig(serializeSavedConfig(config))).toEqual(config);
  });

  it("lets environment variables override saved fields independently", () => {
    const stored = savedConfig({
      baseUrl: "https://saved.example.com",
      apiKey: "cck_saved",
    });
    expect(resolveConfig({ CORPUS_API_KEY: "cck_ci" }, stored)).toEqual({
      baseUrl: "https://saved.example.com",
      apiKey: "cck_ci",
    });
    expect(
      resolveConfig(
        {
          CORPUS_URL: "https://ci.example.com/",
          CORPUS_API_KEY: "cck_ci",
        },
        undefined,
      ),
    ).toEqual({
      baseUrl: "https://ci.example.com",
      apiKey: "cck_ci",
    });
  });

  it("requires both credentials and rejects non-http URLs", () => {
    expect(
      resolveConfig({ CORPUS_URL: "https://example.com" }),
    ).toBeUndefined();
    expect(() => normalizeBaseUrl("file:///tmp/corpus")).toThrow(
      "http:// or https://",
    );
    const embeddedCredentials = ["https://user", "pass@example.com"].join(":");
    expect(() => normalizeBaseUrl(embeddedCredentials)).toThrow(
      "embedded credentials",
    );
    expect(normalizeBaseUrl("https://example.com///")).toBe(
      "https://example.com",
    );
    expect(normalizeBaseUrl("http://127.0.0.1:8787/")).toBe(
      "http://127.0.0.1:8787",
    );
    expect(() => normalizeBaseUrl("http://example.com")).toThrow(
      "must use https://",
    );
  });

  it("never treats empty or relative XDG roots as config directories", () => {
    expect(corpusConfigPath({ XDG_CONFIG_HOME: "" }, "/home/me", "linux")).toBe(
      "/home/me/.config/corpus/config.json",
    );
    expect(
      corpusConfigPath({ XDG_CONFIG_HOME: "relative" }, "/home/me", "linux"),
    ).toBe("/home/me/.config/corpus/config.json");
    expect(
      corpusConfigPath(
        { XDG_CONFIG_HOME: "/private/config" },
        "/home/me",
        "linux",
      ),
    ).toBe("/private/config/corpus/config.json");
    expect(
      corpusConfigPath({ LOCALAPPDATA: "relative" }, "/home/me", "win32"),
    ).toBe("/home/me/AppData/Local/Corpus/config.json");
  });

  it.each([
    [
      { ok: false, segmentCollision: true },
      "collides with an existing file or folder path",
    ],
    [{ ok: false, rolledBack: true }, "could not be completed atomically"],
  ])("explains non-version push conflicts", async (body, message) => {
    await expect(
      push(
        {
          baseUrl: "https://example.com",
          apiKey: "cck_test",
          fetch: () =>
            Promise.resolve(
              new Response(JSON.stringify(body), {
                status: 409,
                headers: { "content-type": "application/json" },
              }),
            ),
          files: {
            readText: (path) =>
              Promise.resolve(path.endsWith(".md") ? "# Draft" : undefined),
            writeText: () => Promise.resolve(),
          },
        },
        "draft",
      ),
    ).rejects.toThrow(message);
  });

  it("bounds doctor connectivity checks", async () => {
    let aborted = false;
    const fetchNever = (
      _input: string,
      init?: RequestInit,
    ): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    await expect(
      doctor(
        {
          baseUrl: "https://example.com",
          apiKey: "cck_test",
          fetch: fetchNever,
          files: {
            readText: () => Promise.resolve(undefined),
            writeText: () => Promise.resolve(),
          },
        },
        1,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(aborted).toBe(true);
  });
});
