#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import process from "node:process";
import { emitKeypressEvents } from "node:readline";

import { corpusConfigPath } from "./config-path.js";
import {
  DEFAULT_CORPUS_URL,
  parseSavedConfig,
  resolveConfig,
  savedConfig,
  serializeSavedConfig,
  type SavedConfig,
} from "./config.js";
import {
  CliError,
  type CorpusConfig,
  doctor,
  list,
  pull,
  push,
  type SyncConfig,
  type TreeFiles,
} from "./core.js";
import { MCP_ADD_USAGE, mcpAdd } from "./mcp-add.js";
import { formatSyncReport, pullAll } from "./sync.js";

const EXIT_ERROR = 1;
// `pull --all` only: local edits were left untouched (re-run with --overwrite
// or resolve them); everything that could be applied was.
const EXIT_CONFLICT = 2;
// `pull --all` only: the server was unreachable or refused the request.
const EXIT_TRANSPORT = 3;

const PULL_USAGE = "usage: corpus pull <slug> [path]";
const PULL_ALL_USAGE = "usage: corpus pull --all [dir] [--overwrite]";

function die(message: string, exitCode: number = EXIT_ERROR): never {
  process.stderr.write(`${message}\n`);
  process.exit(exitCode);
}

function configPath(): string {
  return corpusConfigPath(process.env, homedir(), platform());
}

async function readStoredConfig(
  path: string,
): Promise<SavedConfig | undefined> {
  try {
    return parseSavedConfig(await readFile(path, "utf8"));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw new Error(`Invalid Corpus config at ${path}. Run corpus setup.`, {
      cause: error,
    });
  }
}

const files: TreeFiles = {
  readText: async (path) => {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    }
  },
  writeText: async (path, data) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  },
  remove: (path) => rm(path, { force: true }),
};

function runtimeConfig(config: SavedConfig): CorpusConfig & SyncConfig {
  return { ...config, fetch, files };
}

async function configured(): Promise<
  Readonly<{
    config: SavedConfig;
    path: string;
  }>
> {
  const path = configPath();
  const environmentComplete =
    process.env.CORPUS_URL !== undefined &&
    process.env.CORPUS_API_KEY !== undefined;
  const stored = environmentComplete ? undefined : await readStoredConfig(path);
  const config = resolveConfig(process.env, stored);
  if (config === undefined) {
    die(`Corpus is not configured. Run "corpus setup" (config: ${path}).`);
  }
  return { config, path };
}

type SetupOptions = Readonly<{ url?: string }>;

function parseSetupOptions(args: readonly string[]): SetupOptions {
  let url: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (name !== "--url" || value === undefined || value.startsWith("--")) {
      throw new Error("usage: corpus setup [--url URL]");
    }
    if (url !== undefined) throw new Error("--url may be passed only once.");
    url = value;
  }
  return {
    ...(url === undefined ? {} : { url }),
  };
}

async function promptSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Non-interactive setup needs CORPUS_API_KEY in the environment.",
    );
  }
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write(label);
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = (): void => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onKeypress = (
      text: string,
      key: Readonly<{ name?: string; ctrl?: boolean }>,
    ): void => {
      if (key.ctrl === true && key.name === "c") {
        cleanup();
        reject(new Error("Setup cancelled."));
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        resolve(value);
        return;
      }
      if (key.name === "backspace") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }
      if (text !== "" && key.ctrl !== true) {
        value += text;
        process.stdout.write("•");
      }
    };
    process.stdin.on("keypress", onKeypress);
  });
}

async function writePrivateConfig(
  path: string,
  config: SavedConfig,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.config-${String(process.pid)}-${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(serializeSavedConfig(config), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function setup(args: readonly string[]): Promise<void> {
  const options = parseSetupOptions(args);
  // Setup is the repair path too: an invalid existing file should not prevent
  // the user from replacing it with a verified configuration.
  const current = await readStoredConfig(configPath()).catch(() => undefined);
  const baseUrl =
    options.url ??
    process.env.CORPUS_URL ??
    current?.baseUrl ??
    DEFAULT_CORPUS_URL;
  const suppliedKey =
    process.env.CORPUS_API_KEY ?? (await promptSecret("Corpus API key: "));
  const apiKey =
    suppliedKey.trim() === "" ? (current?.apiKey ?? "") : suppliedKey;
  const config = savedConfig({ baseUrl, apiKey });
  if (!config.apiKey.startsWith("cck_")) {
    throw new Error("Corpus API keys start with cck_.");
  }
  process.stdout.write("Checking connection…\n");
  const result = await doctor(runtimeConfig(config));
  const path = configPath();
  await writePrivateConfig(path, config);
  process.stdout.write(
    `Configured ${config.baseUrl} (${String(result.documentCount)} documents visible).\nSaved ${path}\n`,
  );
}

async function runDoctor(): Promise<void> {
  const { config, path } = await configured();
  const failures: string[] = [];
  const pass = (message: string): void => {
    process.stdout.write(`✓ ${message}\n`);
  };
  const fail = (message: string): void => {
    failures.push(message);
    process.stdout.write(`✗ ${message}\n`);
  };

  pass(`configuration loaded (${path})`);
  pass(`CLI version ${await version()}`);
  try {
    if (platform() === "win32") {
      await access(path, constants.R_OK);
      pass("saved config is readable (Windows ACLs apply)");
    } else {
      const mode = (await stat(path)).mode & 0o777;
      if ((mode & 0o077) === 0) pass("config permissions are private (0600)");
      else fail(`config permissions are too broad (${mode.toString(8)})`);
    }
  } catch {
    if (
      process.env.CORPUS_URL !== undefined &&
      process.env.CORPUS_API_KEY !== undefined
    ) {
      pass("credentials supplied by environment");
    } else {
      fail("saved config file is not readable");
    }
  }
  if (config.apiKey.startsWith("cck_")) pass("API key format looks valid");
  else fail("API key must start with cck_");
  try {
    await access(process.cwd(), constants.W_OK);
    pass(`working directory is writable (${process.cwd()})`);
  } catch {
    fail(`working directory is not writable (${process.cwd()})`);
  }
  try {
    const result = await doctor(runtimeConfig(config));
    pass(
      `server authenticated; ${String(result.documentCount)} documents visible`,
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (failures.length > 0) {
    die(`Doctor found ${String(failures.length)} problem(s).`);
  }
}

async function version(): Promise<string> {
  const packageUrl = new URL("../package.json", import.meta.url);
  const parsed: unknown = JSON.parse(await readFile(packageUrl, "utf8"));
  return typeof parsed === "object" && parsed !== null && "version" in parsed
    ? String(parsed.version)
    : "unknown";
}

function usage(): string {
  return `usage: corpus <command> [options]

Commands:
  setup [--url URL]                  Configure and verify this machine
  doctor                            Check config, permissions, and connectivity
  mcp add [--client cursor|claude-code|vscode]
          [--url URL] [--name NAME] Write an OAuth MCP entry for an agent client
  list                              List documents in the bound corpus
  pull <slug> [path]                Download markdown + version sidecar
  pull --all [dir] [--overwrite]    Write the whole corpus into dir (default .)
                                    exit 0 ok, 1 error, 2 local edits kept, 3 server/auth
  push <slug> [path]                Upload a new conflict-checked version

Environment overrides: CORPUS_URL, CORPUS_API_KEY, CORPUS_CONFIG`;
}

// Single-document pull/push look for a `pull --all` state file in the
// file's ancestor folders; handing the core an absolute path lets that
// search reach the checkout root from any working directory.
function absoluteForwardSlashes(path: string): string {
  return resolve(path).split(sep).join("/");
}

function parsePullAll(
  args: readonly string[],
): Readonly<{ dir: string; overwrite: boolean }> {
  const flags = new Set(["--all", "--overwrite"]);
  const positional = args.filter((a) => !a.startsWith("--"));
  const unknown = args.filter((a) => a.startsWith("--") && !flags.has(a));
  if (unknown.length > 0 || positional.length > 1) die(PULL_ALL_USAGE);
  return {
    dir: positional[0] ?? ".",
    overwrite: args.includes("--overwrite"),
  };
}

async function pullEverything(args: readonly string[]): Promise<void> {
  const { dir, overwrite } = parsePullAll(args);
  const { config } = await configured();
  try {
    const report = await pullAll(runtimeConfig(config), dir, { overwrite });
    for (const line of formatSyncReport(report, dir)) {
      process.stdout.write(`${line}\n`);
    }
    if (report.conflicts.length > 0) process.exit(EXIT_CONFLICT);
  } catch (error) {
    if (error instanceof CliError && error.kind === "http") {
      die(error.message, EXIT_TRANSPORT);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === undefined) die(usage());
  if (command === "setup") {
    return setup(args);
  }
  if (command === "doctor") {
    if (args.length > 0) die("usage: corpus doctor");
    return runDoctor();
  }
  if (command === "mcp") {
    const [sub, ...rest] = args;
    if (sub !== "add") {
      die(MCP_ADD_USAGE);
    }
    try {
      const result = await mcpAdd(rest, {
        home: homedir(),
        cwd: process.cwd(),
        ...(process.env.CORPUS_URL !== undefined
          ? { corpusUrl: process.env.CORPUS_URL }
          : {}),
      });
      if (result.command !== undefined) {
        process.stdout.write(
          `Run this in your terminal, then complete the browser sign-in:\n\n  ${result.command}\n`,
        );
        return;
      }
      process.stdout.write(
        `Wrote ${result.serverName} → ${result.path ?? ""}\n` +
          `Reload your agent, then complete the browser sign-in on first use.\n`,
      );
      return;
    } catch (error) {
      die(error instanceof Error ? error.message : String(error));
    }
  }
  if (command === "--version" || command === "-v") {
    if (args.length > 0) die("usage: corpus --version");
    process.stdout.write(`${await version()}\n`);
    return;
  }
  if (command === "--help" || command === "-h") {
    if (args.length > 0) die("usage: corpus --help");
    process.stdout.write(`${usage()}\n`);
    return;
  }
  switch (command) {
    case "list": {
      if (args.length > 0) die("usage: corpus list");
      const { config } = await configured();
      const cfg = runtimeConfig(config);
      for (const d of await list(cfg)) {
        process.stdout.write(`${d.slug}\tv${d.docVersion}\t${d.title}\n`);
      }
      return;
    }
    case "pull": {
      if (args.includes("--all")) return pullEverything(args);
      const [slug, path] = args;
      if (slug === undefined || args.length > 2) die(PULL_USAGE);
      const { config } = await configured();
      const file = path ?? `${slug}.md`;
      const { doc } = await pull(
        runtimeConfig(config),
        slug,
        absoluteForwardSlashes(file),
      );
      process.stdout.write(`pulled ${slug} (v${doc.docVersion}) → ${file}\n`);
      return;
    }
    case "push": {
      const [slug, path] = args;
      if (slug === undefined || args.length > 2) {
        die("usage: corpus push <slug> [path]");
      }
      const { config } = await configured();
      const { docVersion } = await push(
        runtimeConfig(config),
        slug,
        absoluteForwardSlashes(path ?? `${slug}.md`),
      );
      process.stdout.write(`pushed ${slug} → v${docVersion}\n`);
      return;
    }
    default:
      die(`Unknown command: ${command}\n\n${usage()}`);
  }
}

main().catch((error: unknown) => {
  if (error instanceof CliError) die(error.message);
  die(error instanceof Error ? error.message : String(error));
});
