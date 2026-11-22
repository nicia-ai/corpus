import { describe, expect, it } from "vitest";

import { signUpSession } from "../_helpers";

import {
  fetchFile,
  hashOf,
  newFilesProject,
  pdf,
  png,
  text,
  uploaded,
} from "./_support";

// What a stored file is served with. The type comes from our metadata, never
// R2 or the client; an SVG can never run as a document in the app origin; the
// bytes cache forever but only privately.

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';

describe("GET /api/files/:projectId/:hash", () => {
  it("serves an image inline with the hardening headers", async () => {
    const project = await newFilesProject("hdr-png");
    const bytes = png("served");
    await uploaded(project, bytes, { name: "pic.png" });
    const hash = await hashOf(bytes);

    const res = await fetchFile(project.cookie, project.projectId, hash);

    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable",
    );
    expect(res.headers.get("etag")).toBe(`"${hash}"`);
    expect(res.headers.get("vary")).toContain("Sec-Fetch-Dest");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    expect(res.headers.get("content-disposition")).toMatch(/^inline;/);
  });

  it("serves an SVG inline ONLY when it is loaded as an image", async () => {
    const project = await newFilesProject("hdr-svg");
    const bytes = text(SVG);
    await uploaded(project, bytes, { name: "art.svg" });
    const hash = await hashOf(bytes);

    const asImage = await fetchFile(project.cookie, project.projectId, hash, {
      "sec-fetch-dest": "image",
    });
    const asDocument = await fetchFile(
      project.cookie,
      project.projectId,
      hash,
      { "sec-fetch-dest": "document" },
    );
    const unspecified = await fetchFile(
      project.cookie,
      project.projectId,
      hash,
    );

    expect(asImage.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(asDocument.headers.get("content-disposition")).toMatch(
      /^attachment;/,
    );
    expect(unspecified.headers.get("content-disposition")).toMatch(
      /^attachment;/,
    );
    // Layers two and three hold for every response, whatever the disposition.
    for (const res of [asImage, asDocument, unspecified]) {
      expect(res.headers.get("content-type")).toBe("image/svg+xml");
      expect(res.headers.get("content-security-policy")).toContain("sandbox");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  it("always serves a PDF as a download", async () => {
    const project = await newFilesProject("hdr-pdf");
    const bytes = pdf("doc");
    await uploaded(project, bytes, { name: "doc.pdf" });
    const res = await fetchFile(
      project.cookie,
      project.projectId,
      await hashOf(bytes),
      { "sec-fetch-dest": "image" },
    );
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  it("carries the exact name, in a header-safe form", async () => {
    const project = await newFilesProject("hdr-name");
    const bytes = png("name");
    await uploaded(project, bytes, { name: "café-diagram.png" });
    const res = await fetchFile(
      project.cookie,
      project.projectId,
      await hashOf(bytes),
    );
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toContain('filename="caf_-diagram.png"');
    expect(disposition).toContain("filename*=UTF-8''caf%C3%A9-diagram.png");
  });

  it("answers a revalidation with 304 and no body", async () => {
    const project = await newFilesProject("hdr-304");
    const bytes = png("etag");
    await uploaded(project, bytes, { name: "e.png" });
    const hash = await hashOf(bytes);
    const res = await fetchFile(project.cookie, project.projectId, hash, {
      "if-none-match": `"${hash}"`,
    });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
  });

  it("is a 401 without a session and a 404 for a hash it does not hold", async () => {
    const project = await newFilesProject("hdr-auth");
    const bytes = png("auth");
    await uploaded(project, bytes, { name: "a.png" });
    const hash = await hashOf(bytes);

    expect((await fetchFile("", project.projectId, hash)).status).toBe(401);
    expect(
      (await fetchFile(project.cookie, project.projectId, "f".repeat(64)))
        .status,
    ).toBe(404);
    expect(
      (await fetchFile(project.cookie, project.projectId, "../etc")).status,
    ).toBe(404);
    expect(
      (await fetchFile(project.cookie, project.projectId, hash.toUpperCase()))
        .status,
    ).toBe(404);
  });

  it("never serves a file to a signed-in user who is not a member", async () => {
    const project = await newFilesProject("hdr-member");
    const bytes = png("member");
    await uploaded(project, bytes, { name: "m.png" });
    const outsider = await signUpSession("outsider");
    const res = await fetchFile(
      outsider.headers.get("cookie") ?? "",
      project.projectId,
      await hashOf(bytes),
    );
    expect(res.status).toBe(403);
  });
});
