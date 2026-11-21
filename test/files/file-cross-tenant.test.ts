import { describe, expect, it } from "vitest";

import { asDocumentSlug } from "../../src/ids";
import {
  fileObjectKey,
  projectObjectPrefix,
} from "../../src/store/repos/object-store";

import {
  fetchFile,
  hashOf,
  newFilesProject,
  objects,
  png,
  upload,
  uploaded,
} from "./_support";

// Regression: cross-tenant file access. Modelled on
// `connections-cross-tenant.test.ts`: a caller who is entitled to ONE project
// must get nothing of another's by naming it, by guessing its hash, or by
// uploading the same bytes themselves.
//
// The two defenses under test are structural, not checks to remember: the R2
// key is built from the project id the caller was authorized for, and the
// "does this project hold this file" question is answered by that project's
// own Durable Object.

describe("file isolation between projects", () => {
  it("serves project B nothing of project A's by hash", async () => {
    const a = await newFilesProject("tenant-a");
    const b = await newFilesProject("tenant-b");
    const secret = png("only-a-has-this");
    await uploaded(a, secret, { name: "secret.png" });
    const hash = await hashOf(secret);

    // B's own member, on B's own project: A's hash is simply not there.
    const own = await fetchFile(b.cookie, b.projectId, hash);
    expect(own.status).toBe(404);
    // B's member naming A's project: not a member there.
    const named = await fetchFile(b.cookie, a.projectId, hash);
    expect(named.status).toBe(403);
    // A's member can read it, so the 404/403 above are not a broken route.
    expect((await fetchFile(a.cookie, a.projectId, hash)).status).toBe(200);
  });

  it("does not confirm that another project holds a file, even for identical bytes", async () => {
    const a = await newFilesProject("oracle-a");
    const b = await newFilesProject("oracle-b");
    const shared = png("same-bytes-in-both");
    const hash = await hashOf(shared);
    await uploaded(a, shared, { name: "a.png" });

    // B has not uploaded it: 404, indistinguishable from "nobody has it".
    expect((await fetchFile(b.cookie, b.projectId, hash)).status).toBe(404);

    // B uploads the same bytes: its own object under ITS prefix (no
    // cross-tenant dedupe) and the response says it was created, not found.
    const own = await uploaded(b, shared, { name: "b.png" });
    expect(own.created).toBe(true);
    expect((await fetchFile(b.cookie, b.projectId, hash)).status).toBe(200);
  });

  it("keeps every project's objects under its own prefix", async () => {
    const a = await newFilesProject("prefix-a");
    const b = await newFilesProject("prefix-b");
    const bytes = png("prefixed");
    await uploaded(a, bytes, { name: "a.png" });
    const hash = await hashOf(bytes);
    const bucket = objects();

    expect(await bucket.head(fileObjectKey(a.projectId, hash))).toBeDefined();
    expect(await bucket.head(fileObjectKey(b.projectId, hash))).toBeUndefined();
    const listed = await bucket.list(projectObjectPrefix(b.projectId));
    expect(listed.objects).toEqual([]);
  });

  it("refuses to attach a file to another project's page", async () => {
    const a = await newFilesProject("attach-a");
    const b = await newFilesProject("attach-b");
    // B's member uploads, naming B's project but A's page: A's page does not
    // exist in B's Durable Object, so nothing is attached anywhere.
    const bytes = png("cross-page");
    const onlyInA = await a.store.importDocumentAtPath({
      corpusSlug: a.corpusSlug,
      path: "private/only-in-a.md",
      markdown: "# A\n",
      changedBy: a.userId,
    });
    if (!onlyInA.ok) throw new Error("fixture: could not create the page");
    const attempt = await upload(b, bytes, {
      name: "x.png",
      document: asDocumentSlug(onlyInA.slug),
    });
    expect(attempt.status).toBe(404);
    expect(await a.store.fileByHash(await hashOf(bytes))).toBeUndefined();
    expect(await b.store.fileByHash(await hashOf(bytes))).toBeUndefined();
  });
});
