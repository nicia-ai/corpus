import path from "node:path";

import { cloudflare } from "@cloudflare/vite-plugin";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import {
  configDefaults,
  type ConfigEnv,
  defineConfig,
  type TestProjectConfiguration,
} from "vitest/config";

// One Vite config for dev, build, and test. vitest 4 + the vitest plugin
// runs the pool as a Vite plugin (`cloudflareTest`), and the worker under
// test pulls in TanStack Start via src/server.ts — so the `tanstackStart`
// plugin (which provides the #tanstack-router-entry resolve condition)
// MUST stay present in the test build too. Under vitest we swap the
// dev/build Cloudflare adapter for the test pool.
//
// Three test projects: the suite runs against the default wrangler config
// (no Artifacts or R2 binding — the Git mirror and file uploads are off, as
// for a self-hoster without them), `test/mirror/` runs against the `mirror`
// wrangler environment, which adds the local Artifacts simulator, and
// `test/files/` runs against the `files` environment, which adds local R2.
const MIRROR_TESTS = "test/mirror/**/*.test.ts";
const MIRROR_WRANGLER_ENV = "mirror";
const MIRROR_TEST_TIMEOUT_MS = 30_000;
// Likewise the file-storage tests run against the `files` wrangler
// environment, which adds a local R2 bucket (the `FILES` binding).
// The share-link file test needs R2 too.
const FILES_TESTS = ["test/files/**/*.test.ts", "test/embassy-files.test.ts"];
const FILES_WRANGLER_ENV = "files";

export default defineConfig(async (configEnv: ConfigEnv) => {
  const isVitest = process.env.VITEST === "true" || configEnv.mode === "test";

  const migrations = isVitest
    ? await readD1Migrations(path.join(import.meta.dirname, "drizzle"))
    : [];
  const workerPool = (environment?: string): Plugin =>
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.jsonc",
        ...(environment === undefined ? {} : { environment }),
      },
      miniflare: {
        // Read at config time, applied per test file in the setup
        // file (official vitest-plugin D1 pattern).
        bindings: { TEST_MIGRATIONS: migrations },
      },
    });
  const testProject = (
    name: string,
    options: Readonly<{
      environment?: string;
      include?: string[];
      exclude?: string[];
      testTimeout?: number;
    }>,
  ): TestProjectConfiguration => ({
    extends: true,
    plugins: [workerPool(options.environment)],
    test: {
      name,
      setupFiles: ["./test/apply-migrations.ts"],
      ...(options.testTimeout === undefined
        ? {}
        : { testTimeout: options.testTimeout }),
      ...(options.include === undefined ? {} : { include: options.include }),
      exclude: [
        ...configDefaults.exclude,
        ...(options.exclude ?? []),
        // Local agent worktrees live below this checkout and may have
        // their own dependencies/commits. They are not part of this
        // project instance and must never be collected by `pnpm check`.
        ".claude/worktrees/**",
      ],
    },
  });

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
      ...(isVitest ? [] : [cloudflare({ viteEnvironment: { name: "ssr" } })]),
    ],
    ...(isVitest
      ? {
          test: {
            projects: [
              testProject("worker", {
                exclude: [MIRROR_TESTS, ...FILES_TESTS],
              }),
              testProject("files", {
                environment: FILES_WRANGLER_ENV,
                include: FILES_TESTS,
              }),
              testProject("mirror", {
                environment: MIRROR_WRANGLER_ENV,
                include: [MIRROR_TESTS],
                // Every write pushes a real commit to the simulator: tests
                // that make a few dozen are slow on a busy machine.
                testTimeout: MIRROR_TEST_TIMEOUT_MS,
              }),
            ],
          },
        }
      : {}),
  };
});
