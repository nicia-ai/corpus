import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { asDocumentSlug, asFolderSlug } from "../../src/ids";
import { artifactsMirror } from "../../src/mirror/artifacts-mirror";
import { setGitMirrorForTest } from "../../src/mirror/mirror-for";
import { DEFAULT_CORPUS_SLUG } from "../../src/store/domain/default-corpus";
import { STATE_FILE } from "../../src/store/domain/git-mirror";
import { colSlug } from "../_helpers";

import {
  cliCheckout,
  type Fixture,
  makeDue,
  mirrorExists,
  mirrorRows,
  newFixture,
  put,
  readMirror,
  settle,
  slugAt,
} from "./_support";

// The mirror against the local Artifacts simulator (a real Git server):
// every assertion reads the repository back through the binding, the way a
// clone would see it.

afterEach(() => {
  setGitMirrorForTest(undefined);
});

async function mirrorOf(
  fixture: Fixture,
): Promise<NonNullable<Awaited<ReturnType<typeof readMirror>>>> {
  await settle(fixture);
  const snapshot = await readMirror(fixture.repoName);
  if (snapshot === undefined) throw new Error("the mirror has no commits");
  return snapshot;
}

// Without the trailing newline, with CRLF, and a unicode filename: the bytes
// the mirror must reproduce exactly.
const AWKWARD: readonly (readonly [string, string])[] = [
  ["README.md", "# Handbook\n\nWelcome.\n"],
  ["no-newline.md", "ends without a newline"],
  ["windows.md", "line one\r\nline two\r\n"],
  ["docs/guide.md", "# Guide\n"],
  ["docs/café.md", "# Café\n\nCrème brûlée.\n"],
  ["docs/deep/er/nested.md", "deep\n"],
  // A file and a directory sharing a prefix: git sorts `foo.md` before `foo`.
  ["foo.md", "file\n"],
  ["foo/inside.md", "dir\n"],
];

describe("the mirror's content", () => {
  it("is exactly what `corpus pull --all` writes, byte for byte", async () => {
    const fixture = await newFixture();
    for (const [path, markdown] of AWKWARD) await put(fixture, path, markdown);

    const mirror = await mirrorOf(fixture);
    const checkout = await cliCheckout(fixture);

    expect(checkout.size).toBe(AWKWARD.length + 1);
    expect(new Map(mirror.files)).toEqual(new Map(checkout));
    for (const [path, markdown] of AWKWARD) {
      expect(mirror.files.get(path)).toBe(markdown);
    }
    expect(mirror.files.has(STATE_FILE)).toBe(true);
  });

  it("records the corpus identity in .corpus.json", async () => {
    const fixture = await newFixture();
    await put(fixture, "a.md", "# A\n");
    const mirror = await mirrorOf(fixture);
    const state: unknown = JSON.parse(mirror.files.get(STATE_FILE) ?? "{}");
    expect(state).toMatchObject({
      version: 1,
      corpus: { projectId: fixture.projectId, slug: fixture.corpusSlug },
    });
  });

  it("mirrors an empty corpus as just the state file", async () => {
    const fixture = await newFixture();
    const mirror = await mirrorOf(fixture);
    expect([...mirror.files.keys()]).toEqual([STATE_FILE]);
  });
});

describe("one commit per change set", () => {
  it("makes a small commit on top of the previous head for one edit", async () => {
    const fixture = await newFixture();
    await put(fixture, "docs/a.md", "# A\n");
    await put(fixture, "docs/b.md", "# B\n");
    await put(fixture, "c.md", "# C\n");
    const before = await mirrorOf(fixture);

    await put(fixture, "docs/a.md", "# A, edited\n");
    const after = await mirrorOf(fixture);

    expect(after.commits.length).toBe(before.commits.length + 1);
    expect(after.head.parents).toEqual([before.head.hash]);
    expect(after.files.get("docs/a.md")).toBe("# A, edited\n");
    expect(after.files.get("docs/b.md")).toBe("# B\n");
    expect(after.head.message).toContain("docs/a.md");
    // Only the changed blob, its two directories, the state file and the
    // commit were new: the other files' objects were reused.
    expect(after.files.size).toBe(before.files.size);
  });

  it("credits the person who made the change, under a noreply address", async () => {
    const fixture = await newFixture();
    await put(fixture, "a.md", "# A\n");
    const mirror = await mirrorOf(fixture);
    // The fixture user is named "mirror <n>"; the author is that user's name.
    expect(mirror.head.author.name).toMatch(/^mirror \d+$/u);
    expect(mirror.head.author.email).toBe(
      `${fixture.ownerUserId}@users.noreply.corpus.invalid`,
    );
    expect(mirror.head.committer).toEqual({
      name: "Corpus",
      email: "noreply@corpus.invalid",
    });
  });

  it("makes no commit when nothing changed", async () => {
    const fixture = await newFixture();
    await put(fixture, "a.md", "# A\n");
    const first = await mirrorOf(fixture);
    await settle(fixture);
    await settle(fixture);
    const again = await readMirror(fixture.repoName);
    expect(again?.head.hash).toBe(first.head.hash);
  });

  it("leaves nothing pending once settled", async () => {
    const fixture = await newFixture();
    await put(fixture, "a.md", "# A\n");
    await settle(fixture);
    const [row] = await mirrorRows(fixture);
    expect(row?.synced_generation).toBe(row?.generation);
    expect(row?.attempts).toBe(0);
    expect(
      await fixture.store.gitMirrorStatus(fixture.corpusSlug),
    ).toMatchObject({ enabled: true, state: "synced" });
  });
});

describe("changes that move files around", () => {
  it("deletes a file when its document is renamed", async () => {
    const fixture = await newFixture();
    const slug = await put(fixture, "old-name.md", "# Same body\n");
    await mirrorOf(fixture);

    await fixture.store.renameFilename({
      slug,
      filename: "new-name.md",
      changedBy: fixture.ownerUserId,
    });
    const mirror = await mirrorOf(fixture);
    expect(mirror.files.has("old-name.md")).toBe(false);
    expect(mirror.files.get("new-name.md")).toBe("# Same body\n");
    expect(new Map(mirror.files)).toEqual(await cliCheckout(fixture));
  });

  it("deletes a file when its document is archived", async () => {
    const fixture = await newFixture();
    await put(fixture, "keep.md", "# Keep\n");
    await put(fixture, "docs/drop.md", "# Drop\n");
    await mirrorOf(fixture);

    await fixture.store.archiveDocument(
      await slugAt(fixture, "docs/drop.md"),
      fixture.ownerUserId,
    );
    const mirror = await mirrorOf(fixture);
    expect([...mirror.files.keys()].sort()).toEqual([STATE_FILE, "keep.md"]);
  });

  it("deletes the files of many documents archived in one change", async () => {
    const fixture = await newFixture();
    // More documents than a command looks up one by one.
    const count = 20;
    const slugs = [];
    for (let i = 0; i < count; i += 1) {
      slugs.push(await put(fixture, `old/page-${String(i)}.md`, "# Old\n"));
    }
    await put(fixture, "keep.md", "# Keep\n");
    await mirrorOf(fixture);

    await fixture.store.archiveDocuments(slugs, fixture.ownerUserId);
    const mirror = await mirrorOf(fixture);
    expect([...mirror.files.keys()].sort()).toEqual([STATE_FILE, "keep.md"]);
  });

  it("follows a folder rename", async () => {
    const fixture = await newFixture();
    await put(fixture, "guides/one.md", "# One\n");
    await put(fixture, "guides/two.md", "# Two\n");
    await mirrorOf(fixture);

    const folder = (await fixture.store.listFolders()).find(
      (f) => f.corpusSlug === fixture.corpusSlug && f.name === "guides",
    );
    if (folder === undefined) throw new Error("fixture: no folder");
    await fixture.store.renameFolder(
      asFolderSlug(folder.slug),
      "manuals",
      fixture.ownerUserId,
    );
    const mirror = await mirrorOf(fixture);
    expect([...mirror.files.keys()].sort()).toEqual([
      STATE_FILE,
      "manuals/one.md",
      "manuals/two.md",
    ]);
  });

  it("deletes a file when its document moves out of the corpus, and adds it to the corpus it joins", async () => {
    const fixture = await newFixture();
    const otherSlug = colSlug("other");
    await fixture.store.createCorpus({
      slug: otherSlug,
      name: "Other",
      changedBy: fixture.ownerUserId,
    });
    const slug = await put(fixture, "moving.md", "# Moving\n");
    await put(fixture, "staying.md", "# Staying\n");
    await mirrorOf(fixture);

    await fixture.store.moveDocument(
      slug,
      { corpusSlug: otherSlug, folderSlug: null },
      fixture.ownerUserId,
    );
    await settle(fixture);

    const left = await readMirror(fixture.repoName);
    expect([...(left?.files.keys() ?? [])].sort()).toEqual([
      STATE_FILE,
      "staying.md",
    ]);
    const joined = await readMirror(`${fixture.projectId}.${otherSlug}`);
    expect(joined?.files.get("moving.md")).toBe("# Moving\n");
  });

  it("follows a whole folder moved to another corpus in one change", async () => {
    const fixture = await newFixture();
    const otherSlug = colSlug("other");
    await fixture.store.createCorpus({
      slug: otherSlug,
      name: "Other",
      changedBy: fixture.ownerUserId,
    });
    // More documents than a command looks up one by one.
    const count = 20;
    for (let i = 0; i < count; i += 1) {
      await put(fixture, `big/page-${String(i)}.md`, `# Page ${String(i)}\n`);
    }
    await put(fixture, "stays.md", "# Stays\n");
    await mirrorOf(fixture);

    const folder = (await fixture.store.listFolders()).find(
      (f) => f.corpusSlug === fixture.corpusSlug && f.name === "big",
    );
    if (folder === undefined) throw new Error("fixture: no folder");
    await fixture.store.moveFolder(
      asFolderSlug(folder.slug),
      { corpusSlug: otherSlug, folderSlug: null },
      fixture.ownerUserId,
    );
    await settle(fixture);

    const left = await readMirror(fixture.repoName);
    expect([...(left?.files.keys() ?? [])].sort()).toEqual([
      STATE_FILE,
      "stays.md",
    ]);
    const joined = await readMirror(`${fixture.projectId}.${otherSlug}`);
    expect(
      [...(joined?.files.keys() ?? [])].filter((p) => p.startsWith("big/")),
    ).toHaveLength(count);
  });

  it("publishes a document moved in from Drafts", async () => {
    const fixture = await newFixture();
    await put(fixture, "existing.md", "# Existing\n");
    await fixture.store.ensureDefaultCorpus(fixture.ownerUserId);
    const draft = asDocumentSlug("scratch");
    await fixture.store.saveDocument({
      slug: draft,
      markdown: "# Scratch\n",
      location: { corpusSlug: DEFAULT_CORPUS_SLUG, folderSlug: null },
      clientVersion: 0,
      changedBy: fixture.ownerUserId,
    });
    const before = await mirrorOf(fixture);
    expect(before.files.has("scratch.md")).toBe(false);

    await fixture.store.moveDocument(
      draft,
      { corpusSlug: fixture.corpusSlug, folderSlug: null },
      fixture.ownerUserId,
    );
    const after = await mirrorOf(fixture);
    expect(after.files.get("scratch.md")).toBe("# Scratch\n");
    expect(after.head.parents).toEqual([before.head.hash]);
  });
});

describe("Drafts", () => {
  it("is never mirrored", async () => {
    const fixture = await newFixture();
    await put(fixture, "published.md", "# Published\n");
    await fixture.store.ensureDefaultCorpus(fixture.ownerUserId);
    await fixture.store.saveDocument({
      slug: asDocumentSlug("a-draft"),
      markdown: "# A draft\n",
      location: { corpusSlug: DEFAULT_CORPUS_SLUG, folderSlug: null },
      clientVersion: 0,
      changedBy: fixture.ownerUserId,
    });
    await settle(fixture);

    expect(await fixture.store.gitMirrorStatus(DEFAULT_CORPUS_SLUG)).toEqual({
      enabled: false,
    });
    const rows = await mirrorRows(fixture);
    expect(rows.map((r) => r.corpus_slug)).not.toContain(DEFAULT_CORPUS_SLUG);
    expect(
      await mirrorExists(`${fixture.projectId}.${DEFAULT_CORPUS_SLUG}`),
    ).toBe(false);
    expect((await readMirror(fixture.repoName))?.files.has("a-draft.md")).toBe(
      false,
    );
  });

  it("refuses a clone credential and a rebuild", async () => {
    const fixture = await newFixture();
    expect(await fixture.store.gitCloneAccess(DEFAULT_CORPUS_SLUG)).toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(
      await fixture.store.rebuildGitMirror(
        DEFAULT_CORPUS_SLUG,
        fixture.ownerUserId,
      ),
    ).toEqual({ ok: false, reason: "not-found" });
  });
});

describe("deleting a corpus", () => {
  it("deletes its repository", async () => {
    const fixture = await newFixture();
    await put(fixture, "a.md", "# A\n");
    await mirrorOf(fixture);
    expect(await mirrorExists(fixture.repoName)).toBe(true);

    await fixture.store.deleteCorpus({
      slug: fixture.corpusSlug,
      pages: "archive",
      changedBy: fixture.ownerUserId,
    });
    await settle(fixture);

    expect(await mirrorExists(fixture.repoName)).toBe(false);
    expect(await mirrorRows(fixture)).toEqual([]);
  });
});

describe("rebuilding", () => {
  it("recreates the repository from the current state with no history", async () => {
    const fixture = await newFixture();
    await put(fixture, "a.md", "# A\n");
    await settle(fixture);
    await put(fixture, "a.md", "# A v2\n");
    await settle(fixture);
    await put(fixture, "b.md", "# B\n");
    const before = await mirrorOf(fixture);
    expect(before.commits.length).toBeGreaterThan(2);

    const result = await fixture.store.rebuildGitMirror(
      fixture.corpusSlug,
      fixture.ownerUserId,
    );
    expect(result).toEqual({ ok: true });
    const after = await mirrorOf(fixture);

    expect(after.commits).toHaveLength(1);
    expect(after.head.parents).toEqual([]);
    expect(after.head.hash).not.toBe(before.head.hash);
    expect(new Map(after.files)).toEqual(new Map(before.files));
  });

  it("starts over when someone else wrote to the repository", async () => {
    const fixture = await newFixture();
    await put(fixture, "a.md", "# A\n");
    const before = await mirrorOf(fixture);

    // Reset the DO's memory of what it pushed: the repository's head is now
    // a commit this project cannot account for.
    await runInDurableObject(fixture.store, (_i, state) => {
      state.storage.sql.exec(
        "update mirror_state set last_commit = 'deadbeef'",
      );
    });
    await put(fixture, "a.md", "# A, edited\n");
    const after = await mirrorOf(fixture);

    expect(after.commits).toHaveLength(1);
    expect(after.files.get("a.md")).toBe("# A, edited\n");
    expect(after.head.hash).not.toBe(before.head.hash);
  });

  it("recreates a repository that was deleted out from under it", async () => {
    const fixture = await newFixture();
    await put(fixture, "a.md", "# A\n");
    await mirrorOf(fixture);
    await env.ARTIFACTS?.delete(fixture.repoName);

    await put(fixture, "b.md", "# B\n");
    const mirror = await mirrorOf(fixture);
    expect([...mirror.files.keys()].sort()).toEqual([
      STATE_FILE,
      "a.md",
      "b.md",
    ]);
  });
});

describe("failures", () => {
  it("never fails or delays the save, and retries with backoff", async () => {
    const fixture = await newFixture();
    await put(fixture, "a.md", "# A\n");
    await mirrorOf(fixture);

    setGitMirrorForTest({
      inspect: () => Promise.reject(new Error("artifacts is down")),
      create: () => Promise.reject(new Error("artifacts is down")),
      commit: () => Promise.reject(new Error("artifacts is down")),
      discard: () => Promise.reject(new Error("artifacts is down")),
      cloneAccess: () => Promise.reject(new Error("artifacts is down")),
    });
    const saved = await put(fixture, "a.md", "# A, while down\n");
    expect(saved).toBeDefined();
    expect((await fixture.store.getDocument(saved))?.markdown).toBe(
      "# A, while down\n",
    );

    await settle(fixture);
    const [row] = await mirrorRows(fixture);
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toBe("artifacts is down");
    expect(row?.retry_at).toBeGreaterThan(Date.now());
    expect(row?.synced_generation).toBeLessThan(row?.generation ?? 0);
    expect(
      await fixture.store.gitMirrorStatus(fixture.corpusSlug),
    ).toMatchObject({
      enabled: true,
      state: "error",
      error: "artifacts is down",
    });

    // The service comes back; the backoff elapses.
    setGitMirrorForTest(undefined);
    await makeDue(fixture);
    const mirror = await mirrorOf(fixture);
    expect(mirror.files.get("a.md")).toBe("# A, while down\n");
    const [healed] = await mirrorRows(fixture);
    expect(healed?.attempts).toBe(0);
    expect(healed?.last_error).toBeNull();
  });

  it("does not retry before the backoff has elapsed", async () => {
    const fixture = await newFixture();
    await put(fixture, "a.md", "# A\n");
    await mirrorOf(fixture);
    let calls = 0;
    setGitMirrorForTest({
      inspect: () => {
        calls += 1;
        return Promise.reject(new Error("down"));
      },
      create: () => Promise.reject(new Error("down")),
      commit: () => Promise.reject(new Error("down")),
      discard: () => Promise.reject(new Error("down")),
      cloneAccess: () => Promise.reject(new Error("down")),
    });
    await put(fixture, "a.md", "# A2\n");
    await settle(fixture);
    const afterFirst = calls;
    await settle(fixture);
    await settle(fixture);
    expect(calls).toBe(afterFirst);
  });

  it("gives up after too many attempts until something changes", async () => {
    const fixture = await newFixture();
    await put(fixture, "a.md", "# A\n");
    await mirrorOf(fixture);
    await runInDurableObject(fixture.store, (_i, state) => {
      state.storage.sql.exec(
        "update mirror_state set generation = generation + 1, attempts = 10, last_error = 'gave up', retry_at = null",
      );
    });
    await settle(fixture);
    const [row] = await mirrorRows(fixture);
    expect(row?.attempts).toBe(10);
    expect(row?.synced_generation).toBeLessThan(row?.generation ?? 0);

    await put(fixture, "a.md", "# A, new change\n");
    const mirror = await mirrorOf(fixture);
    expect(mirror.files.get("a.md")).toBe("# A, new change\n");
  });
});

describe("a stale ref", () => {
  it("re-reads the head and retries the push", async () => {
    const fixture = await newFixture();
    await put(fixture, "a.md", "# A\n");
    await mirrorOf(fixture);

    const real = artifactsMirror(env.ARTIFACTS as Artifacts);
    let raced = false;
    let staleSeen = 0;
    setGitMirrorForTest({
      ...real,
      commit: async (request) => {
        if (!raced) {
          raced = true;
          // Another push lands first, on top of the same head: the branch
          // moves, so this request's base is stale.
          const competing = await real.commit({
            ...request,
            edit: {
              writes: [
                {
                  path: "raced.md",
                  content: new TextEncoder().encode("# raced\n"),
                },
              ],
              removals: [],
            },
            message: "competing push\n",
          });
          expect(competing.kind).toBe("pushed");
        }
        const outcome = await real.commit(request);
        if (outcome.kind === "stale") staleSeen += 1;
        return outcome;
      },
    });

    await put(fixture, "a.md", "# A, edited\n");
    await settle(fixture);
    setGitMirrorForTest(undefined);

    expect(raced).toBe(true);
    // The service refused the push as stale (HTTP 200, `ng`) and the mirror
    // recognised it from the branch having moved.
    expect(staleSeen).toBe(1);
    const mirror = await readMirror(fixture.repoName);
    expect(mirror?.files.get("a.md")).toBe("# A, edited\n");
    // The retry started from the competing commit, so history is intact.
    expect(mirror?.commits.length).toBeGreaterThanOrEqual(3);
    const [row] = await mirrorRows(fixture);
    expect(row?.attempts).toBe(0);
    expect(row?.last_error).toBeNull();
  });
});

describe("a crash between the push and the record of it", () => {
  it("adopts the commit that landed and does not push it twice", async () => {
    const fixture = await newFixture();
    await put(fixture, "a.md", "# A\n");
    await mirrorOf(fixture);

    const real = artifactsMirror(env.ARTIFACTS as Artifacts);
    setGitMirrorForTest({
      ...real,
      commit: async (request) => {
        await real.commit(request);
        throw new Error("crashed after the push landed");
      },
    });
    await put(fixture, "a.md", "# A, pushed then crashed\n");
    await settle(fixture);
    setGitMirrorForTest(undefined);
    const landed = await readMirror(fixture.repoName);
    const commitsBefore = landed?.commits.length ?? 0;

    await makeDue(fixture);
    await settle(fixture);
    const mirror = await readMirror(fixture.repoName);
    expect(mirror?.commits.length).toBe(commitsBefore);
    const [row] = await mirrorRows(fixture);
    expect(row?.last_commit).toBe(mirror?.head.hash);
    expect(row?.attempts).toBe(0);
  });
});
