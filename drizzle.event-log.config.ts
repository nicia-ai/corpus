import { defineConfig } from "drizzle-kit";

// The per-Project EventLogStore DO's co-located SQLite event table
// (`event_log` — src/event-log-db.ts). Separate from
// drizzle.do.config.ts (the ProjectStore's ledger) because the two DOs
// own independent SQLite namespaces with independent migration histories
// — they must never share a migrations folder. `driver:
// "durable-sqlite"` makes drizzle-kit emit a self-contained migrations
// bundle (SQL inlined) the EventLogStore DO migrator imports directly.
// Regenerate with `pnpm db:generate:event-log`; the bundle is generated
// verbatim and never hand-edited.
export default defineConfig({
  out: "./drizzle-event-log",
  schema: "./src/event-log-db.ts",
  dialect: "sqlite",
  driver: "durable-sqlite",
});
