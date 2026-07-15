#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { emitKeypressEvents } from "node:readline";
import { createInterface as createPromiseInterface } from "node:readline/promises";

import { corpusConfigPath } from "./config-path.js";
import {
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
  type Files,
  list,
  pull,
  push,
} from "./core.js";

function die(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
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

const files: Files = {
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
  writeText: (path, data) => writeFile(path, data),
};

function runtimeConfig(config: SavedConfig): CorpusConfig {
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

async function prompt(label: string): Promise<string> {
  const rl = createPromiseInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await rl.question(label);
  } finally {
    rl.close();
  }
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
  const suppliedUrl =
    options.url ??
    process.env.CORPUS_URL ??
    (await prompt(
      `Corpus URL${current === undefined ? "" : ` [${current.baseUrl}]`}: `,
    ));
  const baseUrl =
    suppliedUrl.trim() === "" ? (current?.baseUrl ?? "") : suppliedUrl;
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
  list                              List documents in the bound collection
  pull <slug> [path]                Download markdown + version sidecar
  push <slug> [path]                Upload a new conflict-checked version

Environment overrides: CORPUS_URL, CORPUS_API_KEY, CORPUS_CONFIG`;
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
      const [slug, path] = args;
      if (slug === undefined || args.length > 2) {
        die("usage: corpus pull <slug> [path]");
      }
      const { config } = await configured();
      const { file, doc } = await pull(runtimeConfig(config), slug, path);
      process.stdout.write(`pulled ${slug} (v${doc.docVersion}) → ${file}\n`);
      return;
    }
    case "push": {
      const [slug, path] = args;
      if (slug === undefined || args.length > 2) {
        die("usage: corpus push <slug> [path]");
      }
      const { config } = await configured();
      const { docVersion } = await push(runtimeConfig(config), slug, path);
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
