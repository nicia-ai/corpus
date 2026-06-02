// `pnpm check:do-migrations` — fails if the committed
// `drizzle-do/migrations.ts` is stale relative to the Drizzle schema in
// `src/db.ts`. Regenerates against the *committed* snapshot in a temp
// dir (so an unchanged schema is a no-op and the migration tag stays
// stable — a from-scratch regen would pick a new random tag and false
// -positive), then byte-compares the bundle. No git dependency, no
// working-tree mutation. Part of the verification gate.

import { execFile } from "node:child_process";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

import { buildBundleSource } from "./_do-migrations";

const run = promisify(execFile);
const COMMITTED = "drizzle-do/migrations.ts";
// Repo-relative: drizzle-kit resolves `out` as `./<out>` from cwd, so an
// absolute path outside the repo breaks (`.//tmp/...`).
const TMP = ".do-mig-check";

async function main(): Promise<number> {
  const cfg = `.drizzle.do.check.${process.pid.toString()}.config.ts`;
  try {
    await rm(TMP, { recursive: true, force: true });
    // Seed the temp out dir with the committed snapshot + SQL so
    // drizzle-kit diffs against it (no change → no-op; change → a new
    // numbered .sql, which the comparison below then catches).
    await cp("drizzle-do/meta", `${TMP}/meta`, { recursive: true });
    await cp("drizzle-do", TMP, {
      recursive: true,
      filter: (s) => s.endsWith(".sql") || s === "drizzle-do",
    });
    await writeFile(
      cfg,
      `import { defineConfig } from "drizzle-kit";\n` +
        `export default defineConfig({ out: ${JSON.stringify(TMP)}, ` +
        `schema: "./src/db.ts", dialect: "sqlite", driver: "durable-sqlite" });\n`,
    );
    await run("pnpm", ["exec", "drizzle-kit", "generate", "--config", cfg]);

    const expected = await buildBundleSource(TMP);
    const actual = await readFile(COMMITTED, "utf8");
    if (expected !== actual) {
      console.error(
        `✖ ${COMMITTED} is stale w.r.t. src/db.ts.\n` +
          `  Run \`pnpm db:generate:do\` and commit drizzle-do/.`,
      );
      return 1;
    }
    console.error(`✓ ${COMMITTED} is up to date with src/db.ts`);
    return 0;
  } finally {
    await rm(TMP, { recursive: true, force: true });
    await rm(cfg, { force: true });
  }
}

process.exit(await main());
