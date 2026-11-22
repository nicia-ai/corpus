import { describe, expect, it } from "vitest";

import {
  parseState,
  serializeState,
  STATE_VERSION,
  type SyncState,
  type TrackedAsset,
  type TrackedFile,
} from "../cli/sync-state";
import { blobObject } from "../src/store/domain/git/objects";
import { buildPack, storeDeflate } from "../src/store/domain/git/pack";
import {
  chunkPlan,
  commitMessage,
  MIRROR_MAX_FILE_BYTES,
  mirrorManifest,
  planChange,
  planIsEmpty,
} from "../src/store/domain/git-mirror";

import { noisyPng } from "./_images";

// The mirror's pure planning with images and attachments: what the manifest
// holds, what a change is, how a big one is split, and the stored-block pack
// path that keeps compressed images from being deflated twice.

const IDENTITY = { projectId: "p", slug: "c" } as const;
const SHA = (n: number): string => n.toString(16).padStart(64, "0");

const doc = (path: string, n = 1): TrackedFile => ({
  path,
  slug: path.replace(/\W/gu, "-"),
  docVersion: 1,
  sha256: SHA(n),
});
const asset = (path: string, n: number, size = 10): TrackedAsset => ({
  path,
  slug: `f-${path.replace(/\W/gu, "-")}`,
  sha256: SHA(100 + n),
  size,
});
const state = (
  files: readonly TrackedFile[],
  assets: readonly TrackedAsset[] = [],
): SyncState => ({
  version: STATE_VERSION,
  corpus: IDENTITY,
  files,
  ...(assets.length === 0 ? {} : { assets }),
});

describe("mirrorManifest", () => {
  it("records files as assets with their hash and size, beside the documents", () => {
    const manifest = mirrorManifest(
      IDENTITY,
      [
        {
          slug: "a",
          path: "a.md",
          docVersion: 2,
          contentHash: `sha256:${SHA(1)}`,
        },
      ],
      [{ slug: "f1", path: "img/a.png", contentHash: SHA(9), size: 42 }],
    );
    expect(manifest.state.files.map((f) => f.path)).toEqual(["a.md"]);
    expect(manifest.state.assets).toEqual([
      { path: "img/a.png", slug: "f1", sha256: SHA(9), size: 42 },
    ]);
    expect(manifest.skipped).toEqual([]);
  });

  it("leaves a file over the cap, or at an unsafe path, to `skipped`", () => {
    const manifest = mirrorManifest(
      IDENTITY,
      [],
      [
        { slug: "ok", path: "ok.png", contentHash: SHA(1), size: 5 },
        {
          slug: "big",
          path: "big.png",
          contentHash: SHA(2),
          size: MIRROR_MAX_FILE_BYTES + 1,
        },
        { slug: "git", path: ".git/x.png", contentHash: SHA(3), size: 5 },
        { slug: "up", path: "../x.png", contentHash: SHA(4), size: 5 },
      ],
    );
    expect(manifest.state.assets?.map((a) => a.path)).toEqual(["ok.png"]);
    expect(manifest.skipped).toEqual(["big.png", ".git/x.png", "../x.png"]);
  });

  it("serializes exactly like a state without assets when there are none", () => {
    const bare = mirrorManifest(IDENTITY, []);
    expect(serializeState(bare.state)).not.toContain("assets");
    expect(bare.state.assets).toBeUndefined();
  });
});

describe("planChange with assets", () => {
  it("compares assets by hash at their paths, like documents", () => {
    const before = state([doc("a.md")], [asset("x.png", 1), asset("y.png", 2)]);
    const after = state(
      [doc("a.md")],
      [asset("x.png", 1), asset("y.png", 3), asset("z.png", 4)],
    );
    const plan = planChange(before, after);
    expect(plan.upserts).toEqual([]);
    expect(plan.assetUpserts.map((a) => a.path)).toEqual(["y.png", "z.png"]);
    expect(plan.removals).toEqual([]);
  });

  it("removes a deleted or moved asset's old path", () => {
    const before = state([], [asset("x.png", 1), asset("y.png", 2)]);
    const after = state([], [asset("w.png", 1)]);
    const plan = planChange(before, after);
    expect([...plan.removals].sort()).toEqual(["x.png", "y.png"]);
    expect(plan.assetUpserts.map((a) => a.path)).toEqual(["w.png"]);
  });

  it("is empty when nothing changed, and not for a slug-only change", () => {
    const same = state([doc("a.md")], [asset("x.png", 1)]);
    expect(planIsEmpty(planChange(same, same))).toBe(true);
    const renamedSlug = state(
      [doc("a.md")],
      [{ ...asset("x.png", 1), slug: "other" }],
    );
    const plan = planChange(same, renamedSlug);
    expect(plan.assetUpserts).toEqual([]);
    expect(plan.stateChanged).toBe(true);
  });

  it("names images in the commit message", () => {
    const plan = planChange(undefined, state([], [asset("img/a.png", 1)]));
    expect(commitMessage(plan, false)).toBe("Update img/a.png\n");
  });
});

describe("chunkPlan", () => {
  const BUDGET = 100;
  const files = [doc("a.md"), doc("b.md", 2)];
  const assets = ["1", "2", "3", "4"].map((n, i) =>
    asset(`img/${n}.png`, i, 60),
  );

  it("keeps a plan that fits as one commit, whole", () => {
    const next = state(files, assets.slice(0, 1));
    const plan = planChange(undefined, next);
    const chunks = chunkPlan(undefined, next, plan, BUDGET);
    expect(chunks).toEqual([{ plan, state: next }]);
  });

  it("splits by raw bytes, documents and removals first, images in path order", () => {
    const previous = state([doc("old.md")], [asset("gone.png", 9)]);
    const next = state(files, assets);
    const plan = planChange(previous, next);
    const chunks = chunkPlan(previous, next, plan, BUDGET);

    expect(chunks).toHaveLength(assets.length);
    const [first] = chunks;
    expect(first?.plan.upserts.map((f) => f.path)).toEqual(["a.md", "b.md"]);
    expect([...(first?.plan.removals ?? [])].sort()).toEqual([
      "gone.png",
      "old.md",
    ]);
    for (const later of chunks.slice(1)) {
      expect(later.plan.upserts).toEqual([]);
      expect(later.plan.removals).toEqual([]);
    }
    expect(
      chunks.flatMap((c) => c.plan.assetUpserts.map((a) => a.path)),
    ).toEqual(assets.map((a) => a.path));
    for (const chunk of chunks) {
      const bytes = chunk.plan.assetUpserts.reduce((sum, a) => sum + a.size, 0);
      expect(bytes).toBeLessThanOrEqual(BUDGET);
    }
  });

  it("leaves each commit a consistent checkout: previous state plus the commits so far", () => {
    const previous = state(
      [doc("a.md", 7)],
      [asset("img/1.png", 50), asset("keep.png", 77)],
    );
    const next = state(files, [...assets, asset("keep.png", 77)]);
    const plan = planChange(previous, next);
    const chunks = chunkPlan(previous, next, plan, BUDGET);

    // The state each commit leaves, replayed over the tree it started from.
    const tree = new Map<string, string>([
      ["a.md", SHA(7)],
      ["img/1.png", SHA(150)],
      ["keep.png", SHA(177)],
    ]);
    for (const chunk of chunks) {
      for (const path of chunk.plan.removals) tree.delete(path);
      for (const f of chunk.plan.upserts) tree.set(f.path, f.sha256);
      for (const a of chunk.plan.assetUpserts) tree.set(a.path, a.sha256);
      const recorded = new Map<string, string>([
        ...chunk.state.files.map((f) => [f.path, f.sha256] as const),
        ...(chunk.state.assets ?? []).map((a) => [a.path, a.sha256] as const),
      ]);
      expect(recorded).toEqual(tree);
    }
    expect(chunks.at(-1)?.state).toEqual(next);
  });

  it("gives a file larger than the budget a commit of its own", () => {
    const big = [
      asset("a.png", 1, 10),
      asset("b.png", 2, 500),
      asset("c.png", 3, 10),
    ];
    const next = state([], big);
    const chunks = chunkPlan(
      undefined,
      next,
      planChange(undefined, next),
      BUDGET,
    );
    expect(chunks.map((c) => c.plan.assetUpserts.map((a) => a.path))).toEqual([
      ["a.png"],
      ["b.png"],
      ["c.png"],
    ]);
  });

  it("round-trips every intermediate state through the on-disk format", () => {
    const next = state(files, assets);
    for (const chunk of chunkPlan(
      undefined,
      next,
      planChange(undefined, next),
      BUDGET,
    )) {
      expect(parseState(serializeState(chunk.state), "x")).toEqual(
        JSON.parse(JSON.stringify(chunk.state)),
      );
    }
  });
});

async function inflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([data])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("stored zlib blocks", () => {
  it.each([0, 1, 65_534, 65_535, 65_536, 200_000])(
    "inflate back to the same %i bytes",
    async (length) => {
      const data = noisyPng(Math.max(length, 8), 3).slice(0, length);
      expect(await inflate(storeDeflate(data))).toEqual(data);
    },
  );

  it("is what a compressed image takes in a pack, while text is still deflated", async () => {
    const image = noisyPng(50_000, 5);
    const text = new TextEncoder().encode("# Hello\n".repeat(5000));
    const imageBlob = await blobObject(image);
    const textBlob = await blobObject(text);
    const imagePack = await buildPack([imageBlob]);
    const textPack = await buildPack([textBlob]);
    // Header 12 + object header + stored stream (zlib 2 + block header 5 +
    // data + adler 4) + trailing SHA-1 20: a stored image is its size plus
    // framing, a deflated repetitive text is far smaller than its size.
    expect(imagePack.length).toBeGreaterThan(image.length);
    expect(imagePack.length).toBeLessThan(image.length + 200);
    expect(textPack.length).toBeLessThan(text.length / 10);
  });
});
