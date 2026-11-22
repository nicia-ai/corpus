import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { storeFor } from "../../src/control/store-for";
import { setObjectStoreForTest } from "../../src/files/object-store-for";
import { asDocumentSlug } from "../../src/ids";
import {
  fileObjectKey,
  type ObjectStore,
} from "../../src/store/repos/object-store";
import { MAX_FILE_BYTES, MAX_PROJECT_FILE_BYTES } from "../../src/util";

import {
  type FilesProject,
  hashOf,
  jpeg,
  newFilesProject,
  objects,
  pdf,
  png,
  text,
  upload,
  uploaded,
} from "./_support";

// The whole upload path, end to end, over the real local R2 bucket: the
// same-origin gate, the session, byte sniffing, R2 first and the DO second,
// dedupe, naming, and the limits.

afterEach(() => {
  setObjectStoreForTest(undefined);
});

const r2 = objects;

async function objectExists(
  project: FilesProject,
  hash: string,
): Promise<boolean> {
  return (
    (await r2().head(fileObjectKey(project.projectId, hash))) !== undefined
  );
}

describe("ordering: bytes first, metadata second", () => {
  it("has the object in R2 before the DO holds any metadata for it", async () => {
    const project = await newFilesProject("order");
    const bytes = png("order");
    const hash = await hashOf(bytes);
    const real = r2();
    const metadataAtPut: (string | undefined)[] = [];
    setObjectStoreForTest({
      ...real,
      put: async (key, body) => {
        // A fresh stub: the one the fixture made belongs to the test's own
        // request context, not the Worker request this put runs in.
        const store = storeFor(env, project.projectId);
        metadataAtPut.push((await store.fileByHash(hash))?.filename);
        await real.put(key, body);
      },
    });

    await uploaded(project, bytes, { name: "a.png" });

    // At the moment of the put the file did not exist yet; afterwards it does.
    expect(metadataAtPut).toEqual([undefined]);
    expect((await project.store.fileByHash(hash))?.filename).toBe("a.png");
    expect(await objectExists(project, hash)).toBe(true);
  });

  it("puts the object again on every upload, even when it already exists", async () => {
    const project = await newFilesProject("reput");
    const real = r2();
    let puts = 0;
    setObjectStoreForTest({
      ...real,
      put: async (key, body) => {
        puts += 1;
        await real.put(key, body);
      },
    });
    await uploaded(project, png("reput"), { name: "a.png" });
    await uploaded(project, png("reput"), { name: "a.png" });
    // `uploaded` is what the sweep's grace window runs from, so a re-upload
    // must refresh it: a head-then-skip would race the sweep.
    expect(puts).toBe(2);
  });

  it("leaves an orphan object and NO metadata when the commit is refused", async () => {
    const project = await newFilesProject("orphan");
    const bytes = png("orphan");
    const res = await upload(project, bytes, {
      name: "a.png",
      document: asDocumentSlug("no-such-page"),
    });
    expect(res.status).toBe(404);
    const hash = await hashOf(bytes);
    // Bytes are there (the sweep reclaims them); no file a person could see.
    expect(await objectExists(project, hash)).toBe(true);
    expect(await project.store.fileByHash(hash)).toBeUndefined();
  });

  it("never commits metadata when the put itself fails", async () => {
    const project = await newFilesProject("putfail");
    const failing: ObjectStore = {
      ...r2(),
      put: () => Promise.reject(new Error("R2 is down")),
    };
    setObjectStoreForTest(failing);
    const bytes = png("putfail");
    await expect(upload(project, bytes, { name: "a.png" })).resolves.toSatisfy(
      (res: Response) => res.status >= 500,
    );
    expect(await project.store.fileByHash(await hashOf(bytes))).toBeUndefined();
  });
});

describe("dedupe and naming", () => {
  it("returns the same file for the same bytes in the same folder", async () => {
    const project = await newFilesProject("dedupe");
    const first = await uploaded(project, png("same"), { name: "a.png" });
    const second = await uploaded(project, png("same"), { name: "b.png" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.name).toBe("a.png");
    expect(second.url).toBe(first.url);
  });

  it("names a pasted blob from its bytes, so a double paste is one file", async () => {
    const project = await newFilesProject("pasted");
    const bytes = png("shot");
    const first = await uploaded(project, bytes);
    const second = await uploaded(project, bytes);
    const hash = await hashOf(bytes);
    expect(first.name).toBe(`pasted-${hash.slice(0, 8)}.png`);
    expect(second.name).toBe(first.name);
    expect(second.created).toBe(false);
  });

  it("gives a different file with a taken name the next free name", async () => {
    const project = await newFilesProject("collide");
    const a = await uploaded(project, png("one"), { name: "logo.png" });
    const b = await uploaded(project, png("two"), { name: "logo.png" });
    const c = await uploaded(project, png("three"), { name: "logo.png" });
    expect([a.name, b.name, c.name]).toEqual([
      "logo.png",
      "logo-2.png",
      "logo-3.png",
    ]);
    expect(b.path).toBe("guide/logo-2.png");
  });

  it("avoids the name of a page or folder beside it", async () => {
    const project = await newFilesProject("ns");
    await project.store.importDocumentAtPath({
      corpusSlug: project.corpusSlug,
      path: "guide/notes.png.md",
      markdown: "x",
      changedBy: project.userId,
    });
    const body = await uploaded(project, png("ns"), { name: "page.md.png" });
    expect(body.name).toBe("page.md.png");
  });

  it("lands next to the page, and says where", async () => {
    const project = await newFilesProject("where", "a/b/page.md");
    const body = await uploaded(project, png("where"), { name: "pic.png" });
    expect(body.path).toBe("a/b/pic.png");
    expect(body.url).toBe(
      `/api/files/${project.projectId}/${await hashOf(png("where"))}`,
    );
  });

  it("normalizes an awkward name to one safe segment", async () => {
    const project = await newFilesProject("norm");
    const body = await uploaded(project, png("norm"), {
      name: "../My Screen Shot (1).PNG",
    });
    expect(body.name).toBe("My-Screen-Shot-1.png");
  });
});

describe("sniffing: the bytes decide, never the client", () => {
  it("accepts every allowlisted image type and a PDF", async () => {
    const project = await newFilesProject("types");
    const cases = [
      ["a.png", png("t"), "image/png"],
      ["a.jpg", jpeg("t"), "image/jpeg"],
      ["a.pdf", pdf("t"), "application/pdf"],
      [
        "a.svg",
        text('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'),
        "image/svg+xml",
      ],
    ] as const;
    for (const [name, bytes, contentType] of cases) {
      const body = await uploaded(project, bytes, { name });
      expect(body.contentType).toBe(contentType);
    }
  });

  it("refuses bytes that are not an allowlisted type, whatever the client says", async () => {
    const project = await newFilesProject("sniff");
    const res = await upload(project, text("MZ not an image"), {
      name: "x.png",
      headers: { "content-type": "image/png" },
    });
    expect(res.status).toBe(415);
  });

  it("refuses a name whose extension disagrees with the bytes", async () => {
    const project = await newFilesProject("ext");
    expect((await upload(project, png("e"), { name: "x.pdf" })).status).toBe(
      422,
    );
    expect((await upload(project, jpeg("e"), { name: "x.png" })).status).toBe(
      422,
    );
    expect((await upload(project, png("e"), { name: "x" })).status).toBe(422);
  });

  it("refuses an empty body", async () => {
    const project = await newFilesProject("empty");
    expect((await upload(project, new Uint8Array(0))).status).toBe(400);
  });
});

describe("SVG: the first of three defenses", () => {
  const svg = (inner: string): Uint8Array<ArrayBuffer> =>
    text(`<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`);

  it.each([
    ["a script element", svg("<script>alert(1)</script>")],
    ["an event handler", svg('<rect onclick="alert(1)"/>')],
    ["an event handler after a quote", svg('<rect id="a"onload="x()"/>')],
    ["a javascript: URL", svg('<a href="javascript:alert(1)"><rect/></a>')],
    [
      "an obfuscated javascript: URL",
      svg('<a href="java&#115;cript:alert(1)"><rect/></a>'),
    ],
    ["a foreignObject", svg("<foreignObject><div/></foreignObject>")],
    ["an external href", svg('<image href="https://evil.example/x.png"/>')],
    [
      "an external xlink:href",
      svg('<use xlink:href="https://evil.example/s.svg#a"/>'),
    ],
    ["an external CSS url()", svg('<rect style="fill:url(https://e.x/a)"/>')],
    ["a CSS @import", svg("<style>@import 'https://e.x/a.css';</style>")],
  ])("refuses an SVG with %s", async (_label, bytes) => {
    const project = await newFilesProject("svg");
    const res = await upload(project, bytes, { name: "x.svg" });
    expect(res.status).toBe(422);
  });

  it("does not even recognize an SVG whose DOCTYPE declares entities", async () => {
    const project = await newFilesProject("svg-xxe");
    const xxe = text(
      '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/hostname">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>',
    );
    const res = await upload(project, xxe, { name: "x.svg" });
    expect(res.status).toBe(415);
  });

  it("accepts plain vector art, with local references", async () => {
    const project = await newFilesProject("svg-ok");
    const art = svg(
      '<defs><linearGradient id="g"/></defs><rect fill="url(#g)"/><use href="#g"/>',
    );
    const res = await upload(project, art, { name: "ok.svg" });
    expect(res.status).toBe(201);
  });
});

describe("limits", () => {
  it("refuses on Content-Length before reading the body", async () => {
    const project = await newFilesProject("big-header");
    const res = await upload(project, png("x"), {
      name: "x.png",
      headers: { "content-length": String(MAX_FILE_BYTES + 1) },
    });
    expect(res.status).toBe(413);
  });

  it("refuses a body over the cap even with no Content-Length", async () => {
    const project = await newFilesProject("big-stream");
    const chunk = new Uint8Array(1024 * 1024);
    chunk.set(png("big"));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
    });
    const res = await upload(project, body, { name: "big.png" });
    expect(res.status).toBe(413);
  });

  it("accepts a file at exactly the cap", async () => {
    const project = await newFilesProject("at-cap");
    const exact = new Uint8Array(MAX_FILE_BYTES);
    exact.set(png("cap"));
    const res = await upload(project, exact, { name: "cap.png" });
    expect(res.status).toBe(201);
  });

  it("enforces the per-project quota inside the DO, where the total is exact", async () => {
    const project = await newFilesProject("quota");
    const attach = (hash: string, size: number) =>
      project.store.attachFile({
        documentSlug: project.pageSlug,
        name: `${hash}.png`,
        contentHash: hash.padEnd(64, "0"),
        size,
        format: {
          id: "png",
          contentType: "image/png",
          role: "image",
          extension: "png",
          extensions: ["png"],
        },
        changedBy: project.userId,
      });
    expect((await attach("a", MAX_PROJECT_FILE_BYTES - 100)).ok).toBe(true);
    expect(await attach("b", 200)).toEqual({
      ok: false,
      reason: "quota-exceeded",
    });
    // Within the remaining room it still fits; the same bytes again are free.
    expect((await attach("c", 100)).ok).toBe(true);
    expect((await attach("a", MAX_PROJECT_FILE_BYTES - 100)).ok).toBe(true);
  });
});

describe("the request is the session's, and the same origin's", () => {
  it("refuses a cross-origin upload (Origin)", async () => {
    const project = await newFilesProject("csrf-origin");
    const bytes = png("csrf");
    const res = await upload(project, bytes, {
      name: "x.png",
      origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
    expect(await project.store.fileByHash(await hashOf(bytes))).toBeUndefined();
    // Nothing reached R2 either: the check precedes everything.
    expect(await objectExists(project, await hashOf(bytes))).toBe(false);
  });

  it("refuses a cross-site upload (Sec-Fetch-Site)", async () => {
    const project = await newFilesProject("csrf-site");
    const res = await upload(project, png("csrf"), {
      name: "x.png",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(403);
  });

  it("refuses a request that says nothing about where it came from", async () => {
    const project = await newFilesProject("csrf-none");
    const res = await upload(project, png("csrf"), {
      name: "x.png",
      origin: null,
    });
    expect(res.status).toBe(403);
  });

  it("accepts a same-origin request by Sec-Fetch-Site alone", async () => {
    const project = await newFilesProject("csrf-ok");
    const res = await upload(project, png("ok"), {
      name: "x.png",
      origin: null,
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(res.status).toBe(201);
  });

  it("refuses an upload with no session", async () => {
    const project = await newFilesProject("nosession");
    const res = await upload(project, png("n"), { name: "x.png", cookie: "" });
    expect(res.status).toBe(401);
  });

  it("refuses an upload to a project the session is not a member of", async () => {
    const mine = await newFilesProject("mine");
    const theirs = await newFilesProject("theirs");
    const res = await upload(mine, png("t"), {
      name: "x.png",
      project: theirs.projectId,
      document: theirs.pageSlug,
    });
    expect(res.status).toBe(403);
  });
});
