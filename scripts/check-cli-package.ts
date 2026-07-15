import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { z } from "zod";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const CLI = join(ROOT, "cli", "dist", "corpus.js");
const OMITTED_ENV = ["CORPUS_URL", "CORPUS_API_KEY", "CORPUS_CONFIG"];
const CLEAN_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !OMITTED_ENV.includes(name)),
);
const PackResultSchema = z.tuple([
  z.object({
    filename: z.string(),
    files: z.array(z.object({ path: z.string() })),
  }),
]);
const PackageSchema = z.object({ version: z.string() });

type CommandResult = Readonly<{ stdout: string; stderr: string }>;

async function run(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = {},
): Promise<CommandResult> {
  return execFileAsync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: { ...CLEAN_ENV, ...environment },
  });
}

async function fail(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = {},
): Promise<CommandResult> {
  try {
    await run(args, environment);
  } catch (error) {
    if (error instanceof Error) {
      const stdout = "stdout" in error ? String(error.stdout) : "";
      const stderr = "stderr" in error ? String(error.stderr) : error.message;
      return { stdout, stderr };
    }
    return { stdout: "", stderr: String(error) };
  }
  throw new Error(`Expected corpus ${args.join(" ")} to fail.`);
}

async function listen(
  server: ReturnType<typeof createServer>,
): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address !== null && typeof address === "object");
  return address.port;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function main(): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), "corpus-cli-check-"));
  const config = join(temporary, "config.json");
  const server = createServer((request, response) => {
    if (
      request.url === "/api/v1/docs" &&
      request.headers.authorization === "Bearer cck_test"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          documents: [{ slug: "guide", title: "Guide", docVersion: 3 }],
        }),
      );
      return;
    }
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unauthorized" }));
  });

  try {
    const cliPackage = PackageSchema.parse(
      JSON.parse(await readFile(join(ROOT, "cli", "package.json"), "utf8")),
    );
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    const savedEnvironment = {
      CORPUS_API_KEY: "cck_test",
      CORPUS_CONFIG: config,
    };

    const setup = await run(["setup", "--url", baseUrl], savedEnvironment);
    assert.match(setup.stdout, /Configured http:\/\/127\.0\.0\.1:/);
    const original = await readFile(config, "utf8");
    const saved: unknown = JSON.parse(original);
    assert.deepEqual(saved, { baseUrl, apiKey: "cck_test" });
    if (process.platform !== "win32") {
      assert.equal((await stat(config)).mode & 0o077, 0);
      await chmod(config, 0o644);
      const permissions = await fail(["doctor"], {
        CORPUS_CONFIG: config,
      });
      assert.match(permissions.stdout, /permissions are too broad/);
      await chmod(config, 0o600);
    }

    const listed = await run(["list"], { CORPUS_CONFIG: config });
    assert.equal(listed.stdout, "guide\tv3\tGuide\n");
    const healthy = await run(["doctor"], { CORPUS_CONFIG: config });
    assert.match(healthy.stdout, /server authenticated; 1 documents visible/);

    await writeFile(config, "not json\n");
    const environmentOnly = await run(["list"], {
      CORPUS_URL: baseUrl,
      CORPUS_API_KEY: "cck_test",
      CORPUS_CONFIG: config,
    });
    assert.equal(environmentOnly.stdout, "guide\tv3\tGuide\n");

    await writeFile(config, original, { mode: 0o600 });
    const rejectedSetup = await fail(["setup", "--url", baseUrl], {
      CORPUS_API_KEY: "cck_wrong",
      CORPUS_CONFIG: config,
    });
    assert.match(rejectedSetup.stderr, /list failed \(401\)/);
    assert.equal(await readFile(config, "utf8"), original);

    const absentConfig = join(temporary, "absent.json");
    assert.match(
      (await fail([], { CORPUS_CONFIG: absentConfig })).stderr,
      /usage: corpus/,
    );
    const unknown = await fail(["wat"], { CORPUS_CONFIG: absentConfig });
    assert.match(unknown.stderr, /Unknown command: wat/);
    assert.doesNotMatch(unknown.stderr, /not configured/);
    assert.match(
      (await fail(["list", "extra"], { CORPUS_CONFIG: config })).stderr,
      /usage: corpus list/,
    );
    const unreachable = await fail(["doctor"], {
      CORPUS_URL: "http://127.0.0.1:1",
      CORPUS_API_KEY: "cck_test",
      CORPUS_CONFIG: absentConfig,
    });
    assert.match(unreachable.stderr, /Doctor found 1 problem/);

    const packed = await execFileAsync(
      "npm",
      [
        "pack",
        join(ROOT, "cli"),
        "--pack-destination",
        temporary,
        "--ignore-scripts",
        "--json",
      ],
      { cwd: ROOT, env: CLEAN_ENV },
    );
    const packageResult = PackResultSchema.parse(JSON.parse(packed.stdout));
    const paths = packageResult[0].files.map((file) => file.path);
    assert(paths.includes("LICENSE"));
    assert(paths.includes("package.json"));
    assert(paths.includes("dist/corpus.js"));
    assert(paths.includes("dist/core.d.ts"));

    const extracted = join(temporary, "extracted");
    await mkdir(extracted);
    await execFileAsync(
      "tar",
      ["-xzf", join(temporary, packageResult[0].filename), "-C", extracted],
      { cwd: ROOT, env: CLEAN_ENV },
    );
    await symlink(
      join(ROOT, "node_modules"),
      join(extracted, "package", "node_modules"),
      "dir",
    );
    const installedVersion = await execFileAsync(
      process.execPath,
      [join(extracted, "package", "dist", "corpus.js"), "--version"],
      { cwd: extracted, env: CLEAN_ENV },
    );
    assert.equal(installedVersion.stdout, `${cliPackage.version}\n`);

    process.stdout.write("CLI package smoke checks passed.\n");
  } finally {
    await close(server).catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
  }
}

await main();
