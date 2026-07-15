import { z } from "zod";

const SavedConfigSchema = z.object({
  baseUrl: z.string().min(1),
  apiKey: z.string().trim().min(1),
});

export const DEFAULT_CORPUS_URL = "https://corpus.nicia.ai";

export type SavedConfig = Readonly<z.infer<typeof SavedConfigSchema>>;

export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Corpus URL must be an absolute http:// or https:// URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Corpus URL must use http:// or https://.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("Corpus URL must not contain embedded credentials.");
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol === "http:" && !loopback) {
    throw new Error("Corpus URL must use https:// outside this machine.");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function savedConfig(
  input: Readonly<{
    baseUrl: string;
    apiKey: string;
  }>,
): SavedConfig {
  const parsed = SavedConfigSchema.parse(input);
  return {
    baseUrl: normalizeBaseUrl(parsed.baseUrl),
    apiKey: parsed.apiKey,
  };
}

export function parseSavedConfig(raw: string): SavedConfig {
  return savedConfig(SavedConfigSchema.parse(JSON.parse(raw)));
}

// Environment variables override the saved file one field at a time, which
// keeps CI credential injection convenient without discarding a persisted URL.
export function resolveConfig(
  environment: Readonly<{
    CORPUS_URL?: string;
    CORPUS_API_KEY?: string;
  }>,
  stored?: SavedConfig,
): SavedConfig | undefined {
  const baseUrl = environment.CORPUS_URL ?? stored?.baseUrl;
  const apiKey = environment.CORPUS_API_KEY ?? stored?.apiKey;
  return baseUrl === undefined || apiKey === undefined
    ? undefined
    : savedConfig({ baseUrl, apiKey });
}

export function serializeSavedConfig(config: SavedConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}
