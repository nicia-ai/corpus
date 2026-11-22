import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { parseState, sha256HexOfBytes } from "../../cli/sync-state";
import { asFileSlug } from "../../src/ids";
import { artifactsMirror } from "../../src/mirror/artifacts-mirror";
import { setGitMirrorForTest } from "../../src/mirror/mirror-for";
import type { CommitRequest, GitMirror } from "../../src/mirror/port";
import { setMirrorChunkBytesForTest } from "../../src/project-store/git-mirror";
import {
  MIRROR_MAX_FILE_BYTES,
  STATE_FILE,
} from "../../src/store/domain/git-mirror";
import { setGraphStatementSinkForTest } from "../../src/store/statement-log";
import {
  bytesOf,
  hashOf,
  jpeg,
  noisyPng,
  pdf,
  png,
  svg,
  textOf,
} from "../_images";

import {
  cliCheckoutBytes,
  type Fixture,
  makeDue,
  mirrorRows,
  newFixture,
  put,
  putAsset,
  readCommitFiles,
  readMirror,
  settle,
} from "./_support";

// The mirror carries images and attachments: the same tree `corpus pull --all`
// writes, kept current as files are added, replaced, moved and deleted, and
// pushed in bounded commits that each leave a consistent checkout.

afterEach(() => {
  setGitMirrorForTest(undefined);
  setMirrorChunkBytesForTest(undefined);
});

// Run `build` with the mirror unable to push, so the whole corpus is built
// before the first (alarm-driven) pass sees any of it; then let it through. A
// pass that failed meanwhile is made due again. Without this, how many commits
// a corpus takes would depend on when the alarm happened to fire. `release`
// is the mirror the pass runs against afterwards (the real one by default); it
// is installed BEFORE the row is made due, so an alarm that fires at once
// cannot slip a pass through on the wrong mirror.
async function builtWhileHeld(
  fixture: Fixture,
  build: () => Promise<void>,
  release?: GitMirror,
): Promise<void> {
  const held = (): Promise<never> =>
    Promise.reject(new Error("held while the corpus is built"));
  setGitMirrorForTest({
    inspect: held,
    create: held,
    commit: held,
    discard: held,
    cloneAccess: held,
  });
  try {
    await build();
  } finally {
    setGitMirrorForTest(release);
  }
  await makeDue(fixture);
}

async function mirrorOf(
  fixture: Fixture,
): Promise<NonNullable<Awaited<ReturnType<typeof readMirror>>>> {
  await settle(fixture);
  const snapshot = await readMirror(fixture.repoName);
  if (snapshot === undefined) throw new Error("the mirror has no commits");
  return snapshot;
}

// The repository equals a fresh `pull --all`, byte for byte, binaries too.
async function expectMirrorEqualsPull(fixture: Fixture): Promise<void> {
  const mirror = await mirrorOf(fixture);
  const checkout = await cliCheckoutBytes(fixture);
  expect([...mirror.bytes.keys()].sort()).toEqual([...checkout.keys()].sort());
  for (const [path, bytes] of checkout) {
    expect({
      path,
      sha: await sha256HexOfBytes(new Uint8Array(mirror.bytes.get(path) ?? [])),
    }).toEqual({ path, sha: await sha256HexOfBytes(new Uint8Array(bytes)) });
  }
}

// One commit's tree is a consistent checkout: exactly the files its
// `.corpus.json` names, each with the recorded hash.
async function expectConsistentCommit(
  fixture: Fixture,
  treeHash: string,
): Promise<void> {
  const files = await readCommitFiles(fixture.repoName, treeHash);
  const stateBytes = files.get(STATE_FILE);
  if (stateBytes === undefined) throw new Error("commit has no state file");
  const state = parseState(textOf(stateBytes), STATE_FILE);
  const recorded = new Map<string, string>([
    ...state.files.map((f) => [f.path, f.sha256] as const),
    ...(state.assets ?? []).map((a) => [a.path, a.sha256] as const),
  ]);
  const actual = new Map<string, string>();
  for (const [path, bytes] of files) {
    if (path === STATE_FILE) continue;
    actual.set(path, await sha256HexOfBytes(new Uint8Array(bytes)));
  }
  expect(actual).toEqual(recorded);
}

describe("the mirror's content with files", () => {
  it("is exactly what `corpus pull --all` writes, byte for byte", async () => {
    const fixture = await newFixture();
    await put(fixture, "README.md", "# Handbook\n");
    await put(fixture, "docs/guide.md", "# Guide\n\n![a](./a.png)\n");
    await putAsset(fixture, "docs/a.png", png("a"));
    await putAsset(fixture, "docs/deep/b.jpg", jpeg("b"));
    await putAsset(fixture, "logo.svg", svg("logo"));
    await putAsset(fixture, "docs/spec.pdf", pdf("spec"));

    await expectMirrorEqualsPull(fixture);

    const mirror = await mirrorOf(fixture);
    expect(mirror.bytes.get("docs/a.png")).toEqual(png("a"));
    const state = parseState(mirror.files.get(STATE_FILE) ?? "", STATE_FILE);
    expect(state.assets?.map((a) => a.path)).toEqual([
      "docs/a.png",
      "docs/deep/b.jpg",
      "docs/spec.pdf",
      "logo.svg",
    ]);
    expect(state.version).toBe(1);
  });

  it("stores already-compressed images undeflated yet still inflates to the same bytes", async () => {
    const fixture = await newFixture();
    // Pseudo-random, so deflate could not shrink it; the simulator unpacks the
    // pack, so a malformed stored block would fail the push.
    const photo = noisyPng(150_000, 7);
    await putAsset(fixture, "photo.png", photo);
    const mirror = await mirrorOf(fixture);
    expect(
      await hashOf(new Uint8Array(mirror.bytes.get("photo.png") ?? [])),
    ).toBe(await hashOf(photo));
  });

  it("follows a file's life: created, replaced, moved, deleted", async () => {
    const fixture = await newFixture();
    await put(fixture, "page.md", "# Page\n");
    await settle(fixture);
    const base = await mirrorOf(fixture);

    // Created.
    await putAsset(fixture, "img/one.png", png("one"));
    const created = await mirrorOf(fixture);
    expect(created.commits.length).toBe(base.commits.length + 1);
    expect(created.head.message).toContain("img/one.png");
    await expectMirrorEqualsPull(fixture);

    // Replaced in place: same slug and path, new bytes.
    const slug = await putAsset(fixture, "img/one.png", png("one"));
    const oldHash = await hashOf(png("one"));
    const sameSlug = await putAsset(
      fixture,
      "img/one.png",
      png("two"),
      oldHash,
    );
    expect(sameSlug).toBe(slug);
    await expectMirrorEqualsPull(fixture);
    expect((await mirrorOf(fixture)).bytes.get("img/one.png")).toEqual(
      png("two"),
    );

    // Moved and renamed.
    const moved = await fixture.store.moveFileToPath(
      asFileSlug(slug),
      fixture.corpusSlug,
      "pictures/uno.png",
      fixture.ownerUserId,
    );
    expect(moved).toEqual({ ok: true, changed: true });
    await expectMirrorEqualsPull(fixture);
    const afterMove = await mirrorOf(fixture);
    expect(afterMove.bytes.has("img/one.png")).toBe(false);
    expect(afterMove.bytes.get("pictures/uno.png")).toEqual(png("two"));

    // Deleted.
    const deleted = await fixture.store.deleteFileInCorpus(
      asFileSlug(slug),
      fixture.corpusSlug,
      undefined,
      fixture.ownerUserId,
    );
    expect(deleted).toEqual({ ok: true });
    await expectMirrorEqualsPull(fixture);
    const last = await mirrorOf(fixture);
    expect(last.bytes.has("pictures/uno.png")).toBe(false);
    expect(
      parseState(last.files.get(STATE_FILE) ?? "", STATE_FILE).assets,
    ).toBeUndefined();
  });

  it("makes no commit when nothing changed", async () => {
    const fixture = await newFixture();
    await putAsset(fixture, "a.png", png("a"));
    const first = await mirrorOf(fixture);
    await settle(fixture);
    expect((await readMirror(fixture.repoName))?.head.hash).toBe(
      first.head.hash,
    );
  });
});

describe("a large change goes out in several commits", () => {
  const COUNT = 5;
  const SIZE = 60;
  // Each image alone fills a commit's budget.
  const BUDGET = 100;

  async function corpusOfImages(release?: GitMirror): Promise<Fixture> {
    const fixture = await newFixture();
    await builtWhileHeld(
      fixture,
      async () => {
        await put(fixture, "readme.md", "# Readme\n");
        await put(fixture, "docs/guide.md", "# Guide\n");
        for (let i = 0; i < COUNT; i += 1) {
          await putAsset(
            fixture,
            `img/${String(i)}.png`,
            noisyPng(SIZE, i + 1),
          );
        }
      },
      release,
    );
    return fixture;
  }

  it("leaves a consistent checkout after every commit", async () => {
    setMirrorChunkBytesForTest(BUDGET);
    const fixture = await corpusOfImages();
    const mirror = await mirrorOf(fixture);

    expect(mirror.commits.length).toBe(COUNT);
    for (const commit of mirror.commits) {
      await expectConsistentCommit(fixture, commit.treeHash);
    }
    // The documents arrive in the first commit; the images follow in order.
    const oldestFirst = [...mirror.commits].reverse();
    const [first] = oldestFirst;
    if (first === undefined) throw new Error("no commits");
    const firstFiles = await readCommitFiles(fixture.repoName, first.treeHash);
    expect(firstFiles.has("readme.md")).toBe(true);
    expect(firstFiles.has("docs/guide.md")).toBe(true);
    await expectMirrorEqualsPull(fixture);
    const [row] = await mirrorRows(fixture);
    expect(row?.synced_generation).toBe(row?.generation);
  });

  it("survives a failure between two commits and carries on from where it stopped", async () => {
    setMirrorChunkBytesForTest(BUDGET);

    const real = artifactsMirror(env.ARTIFACTS as Artifacts);
    let commits = 0;
    let failFrom: number | undefined = 3;
    const flaky: GitMirror = {
      ...real,
      commit: (request: CommitRequest) => {
        commits += 1;
        if (failFrom !== undefined && commits >= failFrom) {
          return Promise.reject(new Error("injected failure between commits"));
        }
        return real.commit(request);
      },
    };
    const fixture = await corpusOfImages(flaky);

    await settle(fixture);
    const [failed] = await mirrorRows(fixture);
    expect(failed?.last_error).toContain("injected failure");
    expect(failed?.synced_generation).not.toBe(failed?.generation);

    // Two commits landed; the repository is a consistent checkout as it is,
    // and the record follows its head so it is not mistaken for foreign.
    const partial = await readMirror(fixture.repoName);
    expect(partial?.commits.length).toBe(2);
    for (const commit of partial?.commits ?? []) {
      await expectConsistentCommit(fixture, commit.treeHash);
    }
    expect(failed?.last_commit).toBe(partial?.head.hash);

    failFrom = undefined;
    await makeDue(fixture);
    const done = await mirrorOf(fixture);

    // It resumed: the earlier commits are still the history's start.
    expect(done.commits.length).toBe(COUNT);
    expect(done.commits.slice(-2).map((c) => c.hash)).toEqual(
      (partial?.commits ?? []).map((c) => c.hash),
    );
    await expectMirrorEqualsPull(fixture);
  });

  it("splits at the default budget too: a few large files take several commits", async () => {
    const fixture = await newFixture();
    // Three 9 MiB-ish images are 27 MiB raw; the 16 MiB budget fits one per
    // commit with the next pair over it.
    const big = 9 * 1024 * 1024;
    await builtWhileHeld(fixture, async () => {
      await putAsset(fixture, "a.png", noisyPng(big, 1));
      await putAsset(fixture, "b.png", noisyPng(big, 2));
      await putAsset(fixture, "c.png", noisyPng(big, 3));
    });
    const mirror = await mirrorOf(fixture);
    expect(mirror.commits.length).toBe(3);
    await expectMirrorEqualsPull(fixture);
  });
});

describe("files the mirror will not carry", () => {
  it("skips a file over the cap and mirrors everything else", async () => {
    const fixture = await newFixture();
    await put(fixture, "page.md", "# Page\n");
    await putAsset(fixture, "ok.png", png("ok"));
    // Stored under a larger cap than today's: metadata says it is too big, so
    // its bytes are never even read.
    const huge = png("huge");
    const result = await fixture.store.putFileAtPath({
      corpusSlug: fixture.corpusSlug,
      path: "huge.png",
      contentHash: await hashOf(huge),
      size: MIRROR_MAX_FILE_BYTES + 1,
      format: {
        id: "png",
        contentType: "image/png",
        role: "image",
        extension: "png",
        extensions: ["png"],
      },
      baseHash: undefined,
      changedBy: fixture.ownerUserId,
    });
    expect(result.ok).toBe(true);

    const mirror = await mirrorOf(fixture);
    expect([...mirror.bytes.keys()].sort()).toEqual([
      ".corpus.json",
      "ok.png",
      "page.md",
    ]);
    const [row] = await mirrorRows(fixture);
    expect(row?.last_error).toBeNull();
    expect(row?.synced_generation).toBe(row?.generation);
  });
});

describe("the cost of a one-file change with files", () => {
  const SMALL = 3;
  const LARGE = 12;

  async function corpusOf(size: number): Promise<Fixture> {
    const fixture = await newFixture();
    await put(fixture, "readme.md", "# Readme\n");
    for (let i = 0; i < size; i += 1) {
      const dir = ["", "img/", "img/deep/"][i % 3] ?? "";
      await putAsset(fixture, `${dir}p-${String(i)}.png`, png(`p${String(i)}`));
    }
    await settle(fixture);
    return fixture;
  }

  type Work = Readonly<{
    written: readonly string[];
    removed: number;
    portCalls: readonly string[];
    statements: readonly string[];
  }>;

  async function workForOneReplace(fixture: Fixture): Promise<Work> {
    const written: string[] = [];
    const portCalls: string[] = [];
    let removed = 0;
    const real = artifactsMirror(env.ARTIFACTS as Artifacts);
    setGitMirrorForTest({
      ...real,
      inspect: (repo) => {
        portCalls.push("inspect");
        return real.inspect(repo);
      },
      commit: (request) => {
        portCalls.push("commit");
        written.push(...request.edit.writes.map((w) => w.path));
        removed += request.edit.removals.length;
        return real.commit(request);
      },
    });
    const statements: string[] = [];
    const restore = setGraphStatementSinkForTest((sql) => statements.push(sql));
    try {
      await putAsset(
        fixture,
        "img/deep/p-2.png",
        png("replaced"),
        await hashOf(png("p2")),
      );
      await settle(fixture);
    } finally {
      restore();
      setGitMirrorForTest(undefined);
    }
    return { written, removed, portCalls, statements };
  }

  const shapes = (statements: readonly string[]): string[] =>
    statements
      .map((sql) =>
        sql
          .replace(/\s+/gu, " ")
          .replace(/IN \(\?(?:, \?)*\)/gu, "IN (…)")
          .trim(),
      )
      .sort();

  it("does not grow with the number of files", async () => {
    const [small, large] = await Promise.all([
      corpusOf(SMALL),
      corpusOf(LARGE),
    ]);
    const forSmall = await workForOneReplace(small);
    const forLarge = await workForOneReplace(large);

    // The one replaced image and the state file, nothing else.
    expect(forSmall.written).toEqual(["img/deep/p-2.png", ".corpus.json"]);
    expect(forLarge.written).toEqual(forSmall.written);
    expect(forLarge.removed).toBe(forSmall.removed);
    expect(forLarge.portCalls).toEqual(forSmall.portCalls);
    // The same statements against the DO's own storage, however many files.
    expect(shapes(forLarge.statements)).toEqual(shapes(forSmall.statements));
  });
});

describe("a document without files is unaffected", () => {
  it("keeps the state free of an assets array", async () => {
    const fixture = await newFixture();
    await put(fixture, "a.md", "# A\n");
    const mirror = await mirrorOf(fixture);
    expect(JSON.parse(mirror.files.get(STATE_FILE) ?? "{}")).not.toHaveProperty(
      "assets",
    );
    expect(bytesOf(mirror.files.get("a.md") ?? "")).toEqual(bytesOf("# A\n"));
  });
});
