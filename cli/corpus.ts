import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

import {
  CliError,
  type CorpusConfig,
  type Files,
  list,
  pull,
  push,
} from "./core";

// Node entry point for the Corpus CLI. All runtime-specific concerns live
// here — environment, argv, stdout/stderr, exit, and the `node:fs` adapter
// — so the actual list/pull/push logic stays in the portable `./core`
// (web `fetch` + injected ports only), runnable under Deno, Workers, or a
// WASM host with a different shell.
//
// Run: CORPUS_URL=… CORPUS_API_KEY=… pnpm corpus <list|pull|push> …

function die(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const baseUrl = process.env.CORPUS_URL;
const apiKey = process.env.CORPUS_API_KEY;
if (baseUrl === undefined || apiKey === undefined) {
  die("Set CORPUS_URL and CORPUS_API_KEY.");
}

// node:fs adapter for the core's `Files` port. A missing path resolves to
// `undefined` (the port's "absent" contract), so a missing sidecar or file
// is data the core handles, not an exception that escapes here.
const files: Files = {
  readText: async (path) => {
    try {
      return await readFile(path, "utf8");
    } catch {
      return undefined;
    }
  },
  writeText: (path, data) => writeFile(path, data),
};

const cfg: CorpusConfig = { baseUrl, apiKey, fetch, files };

async function main(): Promise<void> {
  const [command, arg1, arg2] = process.argv.slice(2);
  switch (command) {
    case "list": {
      for (const d of await list(cfg)) {
        process.stdout.write(`${d.slug}\tv${d.docVersion}\t${d.title}\n`);
      }
      return;
    }
    case "pull": {
      if (arg1 === undefined) die("usage: corpus pull <slug> [path]");
      const { file, doc } = await pull(cfg, arg1, arg2);
      process.stdout.write(`pulled ${arg1} (v${doc.docVersion}) → ${file}\n`);
      return;
    }
    case "push": {
      if (arg1 === undefined) die("usage: corpus push <slug> [path]");
      const { docVersion } = await push(cfg, arg1, arg2);
      process.stdout.write(`pushed ${arg1} → v${docVersion}\n`);
      return;
    }
    default:
      die("usage: corpus <list|pull|push> [...]");
  }
}

main().catch((e: unknown) => {
  if (e instanceof CliError) die(e.message);
  die(e instanceof Error ? e.message : String(e));
});
