import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { DEFAULT_CORPUS_URL } from "./config.js";

export type McpClient = "cursor" | "claude-code" | "vscode";

export type McpAddResult = Readonly<{
  client: McpClient;
  serverName: string;
  url: string;
  /** Path written, or undefined when the client is configured via a shell command. */
  path?: string;
  /** Shell command to run when we cannot write the client config ourselves. */
  command?: string;
}>;

export const MCP_ADD_USAGE =
  "usage: corpus mcp add [--client cursor|claude-code|vscode] [--url URL] [--name NAME]";

function mcpUrl(raw: string): string {
  const trimmed = raw.replace(/\/$/u, "");
  return trimmed.endsWith("/mcp") ? trimmed : `${trimmed}/mcp`;
}

function parseArgs(args: readonly string[]): Readonly<{
  client: McpClient;
  url: string;
  name: string;
}> {
  let client: McpClient = "cursor";
  let url = mcpUrl(DEFAULT_CORPUS_URL);
  let name = "corpus-default";
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    const next = args[i + 1];
    if (flag === "--client" && next !== undefined) {
      if (next !== "cursor" && next !== "claude-code" && next !== "vscode") {
        throw new Error(MCP_ADD_USAGE);
      }
      client = next;
      i += 1;
      continue;
    }
    if (flag === "--url" && next !== undefined) {
      url = mcpUrl(next);
      i += 1;
      continue;
    }
    if (flag === "--name" && next !== undefined) {
      name = next;
      i += 1;
      continue;
    }
    throw new Error(MCP_ADD_USAGE);
  }
  return { client, url, name };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isJsonObject(parsed) ? parsed : {};
  } catch (error) {
    if (isEnoent(error)) return {};
    throw error;
  }
}

function objectField(
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = parent[key];
  return isJsonObject(value) ? { ...value } : {};
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function mcpAdd(
  args: readonly string[],
  env: Readonly<{
    home: string;
    cwd: string;
    corpusUrl?: string;
  }>,
): Promise<McpAddResult> {
  const parsed = parseArgs(args);
  // Same mcpUrl normalizer as --url: CORPUS_URL may already end in /mcp
  // (corpus setup / docs), so never append blindly.
  const url =
    env.corpusUrl !== undefined && !args.includes("--url")
      ? mcpUrl(env.corpusUrl)
      : parsed.url;

  if (parsed.client === "claude-code") {
    return {
      client: parsed.client,
      serverName: parsed.name,
      url,
      command: `claude mcp add --transport http ${parsed.name} ${url}`,
    };
  }

  const isCursor = parsed.client === "cursor";
  const path = isCursor
    ? join(env.home, ".cursor", "mcp.json")
    : join(env.cwd, ".vscode", "mcp.json");
  const field = isCursor ? "mcpServers" : "servers";
  const existing = await readJsonObject(path);
  const servers = objectField(existing, field);
  servers[parsed.name] = isCursor ? { url } : { type: "http", url };
  await writeJson(path, { ...existing, [field]: servers });
  return {
    client: parsed.client,
    serverName: parsed.name,
    url,
    path,
  };
}
