import { defineConfig } from "drizzle-kit";

// Data plane only: the per-Project ProjectStore DO's co-located SQLite
// ledger tables (`content_blobs`, `change_events` — src/db.ts). Separate
// from drizzle.config.ts (the D1 control plane) because the two schemas
// can't share a migrations folder. `driver: "durable-sqlite"` makes
// drizzle-kit emit a self-contained migrations bundle (SQL inlined) the
// DO migrator imports directly — no .sql text-import / wrangler Text
// rule needed. Regenerate with `pnpm db:generate:do`; the bundle is
// generated verbatim and never hand-edited (cf. `pnpm auth:schema`).
export default defineConfig({
  out: "./drizzle-do",
  schema: "./src/db.ts",
  dialect: "sqlite",
  driver: "durable-sqlite",
});
