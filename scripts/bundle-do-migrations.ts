// Post-step of `pnpm db:generate:do`. drizzle-kit (driver:
// "durable-sqlite") emits a `migrations.js` that text-imports the raw
// `.sql` — that needs a bundler loader (wrangler Text rule) and is
// untyped JS, fragile across this repo's vite / vitest-pool-workers /
// wrangler toolchains. Instead we emit a self-contained, typed
// `drizzle-do/migrations.ts` with the SQL inlined: zero loader
// dependency, identical in every environment, generated verbatim and
// never hand-edited (same model as `pnpm auth:schema`). drizzle-kit
// stays the single source of the DDL; this only reshapes its output
// into the `migrate()` config the DO migrator consumes.

import { readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildBundleSource } from "./_do-migrations";

const DIR = "drizzle-do";

async function main(): Promise<number> {
  await writeFile(join(DIR, "migrations.ts"), await buildBundleSource(DIR));
  // Drop drizzle-kit's loader-dependent JS bundle so there is exactly
  // one bundle (the typed .ts one) in the tree.
  for (const f of await readdir(DIR)) {
    if (f === "migrations.js") await unlink(join(DIR, f));
  }
  console.error(`wrote ${join(DIR, "migrations.ts")}`);
  return 0;
}

process.exit(await main());
