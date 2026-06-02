// Post-step of `pnpm db:generate:event-log`. Same machinery as
// `bundle-do-migrations.ts` but for the EventLogStore DO's migration
// bundle. Two DO classes = two independent migration histories = two
// bundles in the tree.

import { readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildBundleSource } from "./_do-migrations";

const DIR = "drizzle-event-log";

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
