import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { artifactsMirror } from "../../src/mirror/artifacts-mirror";
import { setGitMirrorForTest } from "../../src/mirror/mirror-for";
import type { CommitRequest, GitMirror } from "../../src/mirror/port";
import { setGraphStatementSinkForTest } from "../../src/store/statement-log";

import { type Fixture, newFixture, put, settle } from "./_support";

// The mirror's cost keeper, in the style of bulk-edge-reads.test.ts: what a
// ONE-file change costs must not depend on how big the corpus is. A
// regression (a full-tree rewrite, a per-file read, a re-push of every blob)
// returns identical repository contents — only the cost shows it. So the same
// edit runs over a small and a large corpus and the work is compared;
// invariance across N is the assertion, never an absolute number.
const SMALL = 3;
const LARGE = 12;

afterEach(() => {
  setGitMirrorForTest(undefined);
});

// A repository handle that records every binding call made on it.
function countedRepo(repo: ArtifactsRepo, calls: string[]): ArtifactsRepo {
  return new Proxy(repo, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property);
      if (typeof member !== "function") return member;
      return (...args: unknown[]): unknown => {
        if (typeof property === "string") calls.push(`repo.${property}`);
        return (member as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

function countedArtifacts(artifacts: Artifacts, calls: string[]): Artifacts {
  return new Proxy(artifacts, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property);
      if (typeof member !== "function") return member;
      if (property === "get") {
        return async (name: string): Promise<ArtifactsRepo> =>
          countedRepo(await target.get(name), calls);
      }
      return (...args: unknown[]): unknown => {
        if (typeof property === "string") calls.push(`artifacts.${property}`);
        return (member as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

type Work = Readonly<{
  bindingCalls: readonly string[];
  portCalls: readonly string[];
  filesWritten: readonly string[];
  filesRemoved: number;
  objectsPushed: readonly number[];
  statements: readonly string[];
}>;

async function corpusOf(size: number): Promise<Fixture> {
  const fixture = await newFixture();
  for (let i = 0; i < size; i += 1) {
    // Spread over the root and two nested directories, the same shape at
    // every size.
    const dir = ["", "docs/", "docs/deep/"][i % 3] ?? "";
    await put(fixture, `${dir}file-${String(i)}.md`, `# File ${String(i)}\n`);
  }
  await settle(fixture);
  return fixture;
}

async function workForOneEdit(fixture: Fixture): Promise<Work> {
  const bindingCalls: string[] = [];
  const portCalls: string[] = [];
  const filesWritten: string[] = [];
  const objectsPushed: number[] = [];
  let filesRemoved = 0;
  const real = artifactsMirror(
    countedArtifacts(env.ARTIFACTS as Artifacts, bindingCalls),
  );
  const counted: GitMirror = {
    inspect: (repo) => {
      portCalls.push("inspect");
      return real.inspect(repo);
    },
    create: (repo) => {
      portCalls.push("create");
      return real.create(repo);
    },
    discard: (repo) => {
      portCalls.push("discard");
      return real.discard(repo);
    },
    cloneAccess: (repo, ttl) => real.cloneAccess(repo, ttl),
    commit: async (request: CommitRequest) => {
      portCalls.push("commit");
      filesWritten.push(...request.edit.writes.map((w) => w.path));
      filesRemoved += request.edit.removals.length;
      const outcome = await real.commit(request);
      if (outcome.kind === "pushed") objectsPushed.push(outcome.objects);
      return outcome;
    },
  };
  setGitMirrorForTest(counted);
  const statements: string[] = [];
  const restore = setGraphStatementSinkForTest((sql) => statements.push(sql));
  try {
    // The one-file edit: deep in the tree, so every directory above it is
    // rewritten.
    await put(fixture, "docs/deep/file-2.md", "# File 2, edited\n");
    await settle(fixture);
  } finally {
    restore();
    setGitMirrorForTest(undefined);
  }
  return {
    bindingCalls,
    portCalls,
    filesWritten,
    filesRemoved,
    objectsPushed,
    statements,
  };
}

// A statement's shape, with the N-dependent bind lists collapsed (see
// bulk-edge-reads.test.ts) and sorted: independent reads run concurrently.
function shapes(statements: readonly string[]): string[] {
  return statements
    .map((sql) =>
      sql
        .replace(/\s+/gu, " ")
        .replace(/IN \(\?(?:, \?)*\)/gu, "IN (…)")
        .replace(/(?:WHEN \(.+? IS \?\) THEN \d+ )+/gu, "WHEN … ")
        .replace(/(?: OR \(\(json_extract\(.+?\) IS \?\)\))+/gu, " OR …")
        .trim(),
    )
    .sort();
}

describe("the cost of a one-file change", () => {
  it("does not grow with the size of the corpus", async () => {
    const [small, large] = await Promise.all([
      corpusOf(SMALL),
      corpusOf(LARGE),
    ]);
    // Measured one after the other: the seams are module-level.
    const forSmall = await workForOneEdit(small);
    const forLarge = await workForOneEdit(large);

    // One document and the state file written, nothing removed: not the corpus.
    expect(forSmall.filesWritten).toEqual([
      "docs/deep/file-2.md",
      ".corpus.json",
    ]);
    expect(forLarge.filesWritten).toEqual(forSmall.filesWritten);
    expect(forLarge.filesRemoved).toBe(forSmall.filesRemoved);

    // One push, carrying the same number of objects: the edited blob, the
    // state blob, three trees on the path, and the commit.
    expect(forSmall.objectsPushed).toEqual([6]);
    expect(forLarge.objectsPushed).toEqual(forSmall.objectsPushed);

    // The same calls against Artifacts: reads of the trees on the path only.
    expect(forLarge.portCalls).toEqual(forSmall.portCalls);
    expect([...forLarge.bindingCalls].sort()).toEqual(
      [...forSmall.bindingCalls].sort(),
    );

    // The same statements against the DO's own storage.
    expect(shapes(forLarge.statements)).toEqual(shapes(forSmall.statements));
  });
});
