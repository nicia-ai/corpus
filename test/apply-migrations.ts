import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

// Apply control-plane D1 migrations once before the suite (data-plane DO
// SQLite bootstraps itself lazily in ProjectStore.ensureStore).
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}
