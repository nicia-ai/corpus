import { describe, expect, it } from "vitest";

import {
  normalizeBaseUrl,
  parseSavedConfig,
  resolveConfig,
  savedConfig,
  serializeSavedConfig,
} from "../cli/config";
import { doctor } from "../cli/core";

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
    expect(() => normalizeBaseUrl("https://user:pass@example.com")).toThrow(
      "embedded credentials",
    );
    expect(normalizeBaseUrl("https://example.com///")).toBe(
      "https://example.com",
    );
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
