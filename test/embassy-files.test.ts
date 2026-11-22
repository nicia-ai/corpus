import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { connectControlDb } from "../src/control/db";
import {
  mintEmbassy,
  revokeEmbassy,
  type EmbassyView,
} from "../src/control/embassies";
import type { Grant } from "../src/grant";

import {
  hashOf,
  newFilesProject,
  png,
  text,
  uploaded,
  type FilesProject,
} from "./files/_support";

// What a share-link viewer can fetch: exactly the files THIS page's current
// head references, through a token URL that carries a hash and no path.

const ORIGIN = "https://example.com";
const HTML = { accept: "text/html" };
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';

const withImages = (...names: readonly string[]): string =>
  `# Page\n\n${names.map((n) => `![diagram](./${n})`).join("\n\n")}\n`;

async function shareLink(
  project: FilesProject,
  grant: Grant = "read",
  expiresAt?: number,
): Promise<EmbassyView> {
  return mintEmbassy(connectControlDb(env.DB), {
    projectId: project.projectId,
    documentSlug: project.pageSlug,
    grant,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
}

async function setPage(project: FilesProject, markdown: string): Promise<void> {
  const head = await project.store.getDocument(project.pageSlug);
  if (head === undefined) throw new Error("fixture: page is gone");
  const saved = await project.store.saveDocument({
    slug: project.pageSlug,
    markdown,
    clientVersion: head.docVersion,
    changedBy: project.userId,
  });
  expect(saved.ok).toBe(true);
}

function getFile(
  link: Pick<EmbassyView, "id">,
  hash: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/s/${link.id}/f/${hash}`, { headers });
}

function getPage(
  link: Pick<EmbassyView, "id">,
  headers: Readonly<Record<string, string>>,
): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/s/${link.id}`, { headers });
}

describe("GET /s/:token/f/:hash", () => {
  it("serves a referenced image with the serving headers and a short cache", async () => {
    const project = await newFilesProject("emb-ok");
    const bytes = png("shared");
    await uploaded(project, bytes, { name: "pic.png" });
    await setPage(project, withImages("pic.png"));
    const link = await shareLink(project);
    const hash = await hashOf(bytes);

    const res = await getFile(link, hash);

    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    expect(res.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    expect(res.headers.get("etag")).toBe(`"${hash}"`);
  });

  it("serves an SVG inline only when loaded as an image", async () => {
    const project = await newFilesProject("emb-svg");
    const bytes = text(SVG);
    await uploaded(project, bytes, { name: "art.svg" });
    await setPage(project, withImages("art.svg"));
    const link = await shareLink(project);
    const hash = await hashOf(bytes);

    const asImage = await getFile(link, hash, { "sec-fetch-dest": "image" });
    const asDocument = await getFile(link, hash, {
      "sec-fetch-dest": "document",
    });

    expect(asImage.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(asDocument.headers.get("content-disposition")).toMatch(
      /^attachment;/,
    );
  });

  it("answers a conditional request with 304 for a referenced hash", async () => {
    const project = await newFilesProject("emb-304");
    const bytes = png("etag");
    await uploaded(project, bytes, { name: "pic.png" });
    await setPage(project, withImages("pic.png"));
    const link = await shareLink(project);
    const hash = await hashOf(bytes);

    const res = await getFile(link, hash, { "if-none-match": `"${hash}"` });

    expect(res.status).toBe(304);
  });

  it("404s a file the same project holds that this page does not reference", async () => {
    const project = await newFilesProject("emb-unref");
    const used = png("used");
    const hidden = png("hidden");
    await uploaded(project, used, { name: "used.png" });
    await uploaded(project, hidden, { name: "hidden.png" });
    await setPage(project, withImages("used.png"));
    const link = await shareLink(project);

    expect((await getFile(link, await hashOf(hidden))).status).toBe(404);
    expect((await getFile(link, await hashOf(used))).status).toBe(200);
  });

  it("404s a malformed hash", async () => {
    const project = await newFilesProject("emb-bad");
    const link = await shareLink(project);

    expect((await getFile(link, "..%2F..%2Fetc")).status).toBe(404);
    expect((await getFile(link, "abc")).status).toBe(404);
  });

  it("404s another project's file", async () => {
    const mine = await newFilesProject("emb-mine");
    const theirs = await newFilesProject("emb-theirs");
    const secret = png("theirs-only");
    await uploaded(theirs, secret, { name: "pic.png" });
    await setPage(mine, withImages("pic.png"));
    const link = await shareLink(mine);

    expect((await getFile(link, await hashOf(secret))).status).toBe(404);
  });

  it("refuses a revoked link", async () => {
    const project = await newFilesProject("emb-revoked");
    const bytes = png("revoked");
    await uploaded(project, bytes, { name: "pic.png" });
    await setPage(project, withImages("pic.png"));
    const link = await shareLink(project);
    const hash = await hashOf(bytes);
    expect((await getFile(link, hash)).status).toBe(200);

    await revokeEmbassy(connectControlDb(env.DB), {
      id: link.id,
      projectId: project.projectId,
    });

    expect((await getFile(link, hash)).status).toBe(404);
  });

  it("refuses an expired link", async () => {
    const project = await newFilesProject("emb-expired");
    const bytes = png("expired");
    await uploaded(project, bytes, { name: "pic.png" });
    await setPage(project, withImages("pic.png"));
    const link = await shareLink(project, "read", Date.now() - 1000);

    expect((await getFile(link, await hashOf(bytes))).status).toBe(404);
  });

  it("stops serving an image once a newer version drops it", async () => {
    const project = await newFilesProject("emb-removed");
    const kept = png("kept");
    const dropped = png("dropped");
    await uploaded(project, kept, { name: "kept.png" });
    await uploaded(project, dropped, { name: "dropped.png" });
    await setPage(project, withImages("kept.png", "dropped.png"));
    const link = await shareLink(project);
    const droppedHash = await hashOf(dropped);
    expect((await getFile(link, droppedHash)).status).toBe(200);

    await setPage(project, withImages("kept.png"));

    expect((await getFile(link, droppedHash)).status).toBe(404);
    expect((await getFile(link, await hashOf(kept))).status).toBe(200);
  });

  it("resolves images relative to the page's own path", async () => {
    const project = await newFilesProject("emb-rel", "guide/deep/page.md");
    const bytes = png("beside");
    await uploaded(project, bytes, { name: "pic.png" });
    const link = await shareLink(project);
    const hash = await hashOf(bytes);

    await setPage(project, withImages("pic.png"));
    expect((await getFile(link, hash)).status).toBe(200);

    await setPage(project, "# Page\n\n![x](../pic.png)\n");
    expect((await getFile(link, hash)).status).toBe(404);
  });
});

describe("the shared page's HTML", () => {
  it.each<Grant>(["read", "suggest", "edit"])(
    "points %s-link images at the token route and exposes no path",
    async (grant) => {
      const project = await newFilesProject(`emb-html-${grant}`);
      const bytes = png(`html-${grant}`);
      await uploaded(project, bytes, { name: "private-name.png" });
      await setPage(project, withImages("private-name.png"));
      const link = await shareLink(project, grant);
      const hash = await hashOf(bytes);

      const res = await getPage(link, HTML);
      const html = await res.text();

      expect(res.status).toBe(200);
      expect(html).toContain(`<img src="/s/${link.id}/f/${hash}"`);
      expect(html).not.toContain("/api/files");
      expect(html).not.toContain(project.projectId);
      const start = html.indexOf('<article class="md">');
      const article = html.slice(start, html.indexOf("</article>", start));
      expect(article).not.toContain("private-name.png");
    },
  );

  it("renders a placeholder, not a request, for an image it cannot resolve", async () => {
    const project = await newFilesProject("emb-missing");
    await setPage(project, withImages("nowhere.png"));
    const link = await shareLink(project);

    const html = await (await getPage(link, HTML)).text();

    expect(html).toContain("Missing image");
    expect(html).not.toContain("<img");
  });

  it("offers no upload control on an edit link", async () => {
    const project = await newFilesProject("emb-noupload");
    const link = await shareLink(project, "edit");

    const html = await (await getPage(link, HTML)).text();

    expect(html).not.toMatch(/type="file"/);
  });

  it("leaves the markdown agents read canonical", async () => {
    const project = await newFilesProject("emb-md");
    await uploaded(project, png("md"), { name: "pic.png" });
    const markdown = withImages("pic.png");
    await setPage(project, markdown);
    const link = await shareLink(project);

    const res = await getPage(link, { accept: "text/markdown" });

    expect(await res.text()).toBe(markdown);
  });
});
