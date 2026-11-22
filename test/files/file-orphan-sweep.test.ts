import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { connectControlDb } from "../../src/control/db";
import {
  reconcileProjects,
  reconcileRetention,
} from "../../src/control/project-reconciliation";
import { project } from "../../src/control/schema/app";
import { ORPHAN_GRACE_MS } from "../../src/files/orphan-sweep";
import { asDocumentSlug, asFolderSlug } from "../../src/ids";
import {
  fileObjectKey,
  projectObjectPrefix,
} from "../../src/store/repos/object-store";

import {
  type FilesProject,
  hashOf,
  newFilesProject,
  objects,
  png,
  upload,
  uploaded,
} from "./_support";

// Bytes go to R2 first and metadata second, so a failure between the two
// strands bytes no File names. The sweep reclaims them, and its grace window
// is what makes bytes-first safe: an upload still committing is never taken
// for an orphan. The clock is the `nowMs` seam `reconcileRetention` exposes
// (like `reapExpired`'s); nothing here waits.

const DAY = 86_400_000;

async function held(p: FilesProject, hash: string): Promise<boolean> {
  return (await objects().head(fileObjectKey(p.projectId, hash))) !== undefined;
}

// An upload whose commit never happens: the page does not exist, so the DO
// refuses after the bytes are already in R2.
async function strandedUpload(p: FilesProject, seed: string): Promise<string> {
  const bytes = png(seed);
  const res = await upload(p, bytes, {
    name: `${seed}.png`,
    document: asDocumentSlug("no-such-page"),
  });
  expect(res.status).toBe(404);
  return hashOf(bytes);
}

describe("orphan sweep", () => {
  it("deletes an object whose commit never happened, once the grace window passes", async () => {
    const p = await newFilesProject("sweep-orphan");
    const hash = await strandedUpload(p, "stranded");
    expect(await held(p, hash)).toBe(true);

    // Inside the grace window it is spared: an upload may still be committing.
    await reconcileRetention(env, Date.now() + ORPHAN_GRACE_MS - 60_000);
    expect(await held(p, hash)).toBe(true);

    await reconcileRetention(env, Date.now() + ORPHAN_GRACE_MS + 60_000);
    expect(await held(p, hash)).toBe(false);
  });

  it("keeps an object a File references, however old", async () => {
    const p = await newFilesProject("sweep-kept");
    const bytes = png("kept");
    await uploaded(p, bytes, { name: "kept.png" });
    const hash = await hashOf(bytes);

    await reconcileRetention(env, Date.now() + 30 * DAY);

    expect(await held(p, hash)).toBe(true);
    expect((await p.store.fileByHash(hash))?.filename).toBe("kept.png");
  });

  it("keeps the bytes of a soft-deleted file until the reaper has removed it", async () => {
    const p = await newFilesProject("sweep-deleted", "docs/page.md");
    const bytes = png("deleted");
    await uploaded(p, bytes, { name: "gone.png" });
    const hash = await hashOf(bytes);
    const folder = (await p.store.listFolders()).find((f) => f.name === "docs");
    if (folder === undefined) throw new Error("fixture: no docs folder");
    const deleted = await p.store.deleteFolder(
      asFolderSlug(folder.slug),
      p.userId,
    );
    expect(deleted.ok).toBe(true);
    expect(await p.store.fileByHash(hash)).toBeUndefined();

    // The node survives (soft-deleted), so its bytes do.
    await reconcileRetention(env, Date.now() + 30 * DAY);
    expect(await held(p, hash)).toBe(true);

    // Reap the node past its window; no node names the hash, so the next
    // sweep (the one after the reap) reclaims the bytes.
    await p.store.reapExpired({ fileDays: 7 }, Date.now() + 8 * DAY);
    expect(await p.store.referencedFileHashes()).toEqual([]);
    await reconcileRetention(env, Date.now() + 30 * DAY);
    expect(await held(p, hash)).toBe(false);
  });

  it("refreshes an object's age on every upload, which the grace window keys on", async () => {
    const p = await newFilesProject("sweep-reput");
    const bytes = png("reput");
    const hash = await hashOf(bytes);
    await strandedUpload(p, "reput");
    const key = fileObjectKey(p.projectId, hash);
    const before = (await objects().head(key))?.uploadedMs ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 20));

    await uploaded(p, bytes, { name: "reput.png" });

    const after = (await objects().head(key))?.uploadedMs ?? 0;
    expect(after).toBeGreaterThan(before);
  });

  it("sweeps each project's prefix only", async () => {
    const a = await newFilesProject("sweep-a");
    const b = await newFilesProject("sweep-b");
    const hashA = await strandedUpload(a, "iso-a");
    const keptB = png("iso-b");
    await uploaded(b, keptB, { name: "b.png" });

    await reconcileRetention(env, Date.now() + 3 * DAY);

    expect(await held(a, hashA)).toBe(false);
    expect(await held(b, await hashOf(keptB))).toBe(true);
  });
});

describe("project deletion", () => {
  it("removes every object under the project's prefix", async () => {
    const p = await newFilesProject("purge");
    await uploaded(p, png("p1"), { name: "p1.png" });
    await strandedUpload(p, "p2");
    expect(
      (await objects().list(projectObjectPrefix(p.projectId))).objects,
    ).toHaveLength(2);

    await connectControlDb(env.DB)
      .update(project)
      .set({ status: "deleted" })
      .where(eq(project.id, p.projectId));
    await reconcileProjects(env);

    expect(
      (await objects().list(projectObjectPrefix(p.projectId))).objects,
    ).toEqual([]);
  });
});
