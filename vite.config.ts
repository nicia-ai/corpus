import path from "node:path";

import { cloudflare } from "@cloudflare/vite-plugin";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { configDefaults, type ConfigEnv, defineConfig } from "vitest/config";

// One Vite config for dev, build, and test. vitest 4 + pool-workers 0.16
// runs the pool as a Vite plugin (`cloudflareTest`), and the worker under
// test pulls in TanStack Start via src/server.ts — so the `tanstackStart`
// plugin (which provides the #tanstack-router-entry resolve condition)
// MUST stay present in the test build too. Under vitest we swap the
// dev/build Cloudflare adapter for the test pool.
export default defineConfig(async (configEnv: ConfigEnv) => {
  const isVitest = process.env.VITEST === "true" || configEnv.mode === "test";

  const runtimePlugins = isVitest
    ? [
        cloudflareTest({
          wrangler: { configPath: "./wrangler.jsonc" },
          isolatedStorage: false,
          miniflare: {
            // Read at config time, applied per test file in the setup
            // file (official vitest-pool-workers D1 pattern).
            bindings: {
              TEST_MIGRATIONS: await readD1Migrations(
                path.join(import.meta.dirname, "drizzle"),
              ),
            },
          },
        }),
      ]
    : [cloudflare({ viteEnvironment: { name: "ssr" } })];

  return {
    server: { port: 8787 },
    resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
    optimizeDeps: { exclude: ["wrangler"] },
    plugins: [
      tailwindcss(),
      tanstackStart({
        srcDirectory: "src",
        start: { entry: "./start.tsx" },
        server: { entry: "./server.ts" },
      }),
      viteReact(),
      ...runtimePlugins,
    ],
    ...(isVitest
      ? {
          test: {
            setupFiles: ["./test/apply-migrations.ts"],
            // Local agent worktrees live below this checkout and may have
            // their own dependencies/commits. They are not part of this
            // project instance and must never be collected by `pnpm check`.
            exclude: [...configDefaults.exclude, ".claude/worktrees/**"],
          },
        }
      : {}),
  };
});
