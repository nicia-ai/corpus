import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import { beforeAll } from "vitest";

// Apply control-plane D1 migrations once before the suite (data-plane DO
// SQLite bootstraps itself lazily in ProjectStore.ensureStore).
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

// `cloudflare:test` types `env` as `Cloudflare.Env` (the wrangler-generated
// namespace), not the older `ProvidedEnv`. `TEST_MIGRATIONS` is injected by
// `vite.config.ts` via `miniflare.bindings`, so it is declared here rather
// than in wrangler.jsonc — this is the only place that seam is typed.
declare global {
  // Augmenting a generated global namespace has no ES-module form; the
  // no-namespace rule's "prefer modules" premise does not apply here.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
