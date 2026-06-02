import { defineConfig } from "drizzle-kit";

// Control plane only (D1). The data-plane ledger tables (per-Project
// ProjectStore DO SQLite) have their own config — drizzle.do.config.ts
// (`pnpm db:generate:do`) — because the two schemas can't share a
// migrations folder.
export default defineConfig({
  out: "./drizzle",
  schema: "./src/control/schema/index.ts",
  dialect: "sqlite",
});
