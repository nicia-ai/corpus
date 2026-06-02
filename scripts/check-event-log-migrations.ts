// `pnpm check:event-log-migrations` — fails if the committed
// `drizzle-event-log/migrations.ts` is stale relative to the Drizzle
// schema in `src/event-log-db.ts`. Sibling to `check-do-migrations.ts`
// (which guards the ProjectStore ledger bundle). Same machinery,
// different schema + bundle dir.

import { execFile } from "node:child_process";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

import { buildBundleSource } from "./_do-migrations";

const run = promisify(execFile);
const COMMITTED = "drizzle-event-log/migrations.ts";
const TMP = ".event-log-mig-check";

async function main(): Promise<number> {
  const cfg = `.drizzle.event-log.check.${process.pid.toString()}.config.ts`;
  try {
    await rm(TMP, { recursive: true, force: true });
    await cp("drizzle-event-log/meta", `${TMP}/meta`, { recursive: true });
    await cp("drizzle-event-log", TMP, {
      recursive: true,
      filter: (s) => s.endsWith(".sql") || s === "drizzle-event-log",
    });
    await writeFile(
      cfg,
      `import { defineConfig } from "drizzle-kit";\n` +
        `export default defineConfig({ out: ${JSON.stringify(TMP)}, ` +
        `schema: "./src/event-log-db.ts", dialect: "sqlite", driver: "durable-sqlite" });\n`,
    );
    await run("pnpm", ["exec", "drizzle-kit", "generate", "--config", cfg]);

    const expected = await buildBundleSource(TMP);
    const actual = await readFile(COMMITTED, "utf8");
    if (expected !== actual) {
      console.error(
        `✖ ${COMMITTED} is stale w.r.t. src/event-log-db.ts.\n` +
          `  Run \`pnpm db:generate:event-log\` and commit drizzle-event-log/.`,
      );
      return 1;
    }
    console.error(`✓ ${COMMITTED} is up to date with src/event-log-db.ts`);
    return 0;
  } finally {
    await rm(TMP, { recursive: true, force: true });
    await rm(cfg, { force: true });
  }
}

process.exit(await main());
