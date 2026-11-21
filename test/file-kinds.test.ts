import { describe, expect, it } from "vitest";

import {
  fileResponseHeaders,
  judgeUpload,
  normalizeFileName,
  pastedFileName,
  sniffFormat,
  svgProblem,
  uniqueFileName,
} from "../src/store/domain/file-kinds";
import { MAX_FILE_BYTES } from "../src/util";

// The upload rules are pure: no DO, no R2, no request. The end-to-end
// behaviour (status codes, ordering) is in test/files/.

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const ascii = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("sniffFormat: the bytes decide", () => {
  const cases: readonly (readonly [string, Uint8Array, string])[] = [
    ["PNG", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1), "png"],
    ["JPEG", bytes(0xff, 0xd8, 0xff, 0xe0, 0), "jpeg"],
    ["GIF89a", ascii("GIF89a....."), "gif"],
    ["GIF87a", ascii("GIF87a....."), "gif"],
    ["WebP", ascii("RIFF\0\0\0\0WEBPVP8 "), "webp"],
    ["AVIF", ascii("\0\0\0\x1cftypavif\0\0\0\0"), "avif"],
    ["PDF", ascii("%PDF-1.7\n"), "pdf"],
    ["SVG", ascii('<svg xmlns="http://www.w3.org/2000/svg"/>'), "svg"],
    [
      "SVG after an XML declaration, a comment and a plain DOCTYPE",
      ascii(
        '\uFEFF<?xml version="1.0"?>\n<!-- hi -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n<svg/>',
      ),
      "svg",
    ],
  ];

  it.each(cases)("recognizes %s", (_name, input, id) => {
    expect(sniffFormat(input)?.id).toBe(id);
  });

  it.each([
    ["an executable", ascii("MZ\x90\0")],
    ["a script", ascii("#!/bin/sh\necho hi\n")],
    ["HTML", ascii("<html><body>hi</body></html>")],
    ["a RIFF that is not WebP", ascii("RIFF\0\0\0\0WAVEfmt ")],
    ["an ISO file that is not AVIF", ascii("\0\0\0\x1cftypmp42\0\0\0\0")],
    ["an empty file", bytes()],
  ])("does not recognize %s", (_name, input) => {
    expect(sniffFormat(input)).toBeUndefined();
  });
});

describe("svgProblem", () => {
  const svg = (inner: string) =>
    ascii(`<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`);

  it("accepts art that references only itself", () => {
    expect(
      svgProblem(svg('<defs><path id="p"/></defs><use href="#p"/>')),
    ).toBeUndefined();
    expect(
      svgProblem(svg('<image href="data:image/png;base64,AAAA"/>')),
    ).toBeUndefined();
  });

  it.each([
    ["<script>x</script>"],
    ["<SCRIPT>x</SCRIPT>"],
    ['<rect onmouseover="x()"/>'],
    ['<a href="javascript:x()"/>'],
    ['<a href=" jav&#x61;script:x()"/>'],
    ['<a href="data:text/html,<script>x</script>"/>'],
    ["<foreignObject/>"],
    ["<iframe/>"],
    ['<use href="//evil.example/a.svg#x"/>'],
    ['<use xlink:href="http://evil.example/a.svg#x"/>'],
    ['<rect style="background:url(http://e.x/a.png)"/>'],
    ["<style>@import url(x);</style>"],
  ])("refuses %s", (inner) => {
    expect(svgProblem(svg(inner))).toBeDefined();
  });

  it("refuses bytes that are not valid UTF-8", () => {
    expect(svgProblem(bytes(0x3c, 0x73, 0xff, 0xfe))).toBe(
      "is not valid UTF-8 text",
    );
  });
});

describe("normalizeFileName", () => {
  it.each([
    [
      "Screen Shot 2026-01-01 at 10.00.00.PNG",
      "Screen-Shot-2026-01-01-at-10.00.00.png",
    ],
    ["../../etc/passwd.png", "passwd.png"],
    ["C:\\Users\\me\\pic.jpeg", "pic.jpeg"],
    [".hidden.png", "hidden.png"],
    ["a (1) [copy].png", "a-1-copy.png"],
    ["café.png", "café.png"],
    ["a/b/c.gif", "c.gif"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeFileName(input)).toBe(expected);
  });

  it("returns undefined when nothing usable is left", () => {
    expect(normalizeFileName("...")).toBeUndefined();
    expect(normalizeFileName("///")).toBeUndefined();
    expect(normalizeFileName("")).toBeUndefined();
  });

  it("caps the stem and keeps the extension", () => {
    const name = normalizeFileName(`${"x".repeat(300)}.png`);
    expect(name?.endsWith(".png")).toBe(true);
    expect((name ?? "").length).toBeLessThanOrEqual(104);
  });
});

describe("naming", () => {
  it("derives a pasted name from the bytes' hash", () => {
    const png = sniffFormat(
      bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    );
    if (png === undefined) throw new Error("png must sniff");
    expect(pastedFileName("deadbeef".padEnd(64, "0"), png)).toBe(
      "pasted-deadbeef.png",
    );
  });

  it("picks the first free numbered name", () => {
    expect(uniqueFileName("a.png", new Set())).toBe("a.png");
    expect(uniqueFileName("a.png", new Set(["a.png"]))).toBe("a-2.png");
    expect(uniqueFileName("a.png", new Set(["a.png", "a-2.png"]))).toBe(
      "a-3.png",
    );
    expect(uniqueFileName("noext", new Set(["noext"]))).toBe("noext-2");
  });
});

describe("judgeUpload", () => {
  const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7);

  it("accepts a matching name, or none", () => {
    expect(judgeUpload(png, "a.PNG")).toMatchObject({
      ok: true,
      name: "a.png",
    });
    expect(judgeUpload(png, undefined)).toMatchObject({
      ok: true,
      name: undefined,
    });
    expect(judgeUpload(png, "  ")).toMatchObject({ ok: true, name: undefined });
  });

  it("accepts both JPEG extensions", () => {
    const jpeg = bytes(0xff, 0xd8, 0xff, 0xe0);
    expect(judgeUpload(jpeg, "a.jpg")).toMatchObject({ ok: true });
    expect(judgeUpload(jpeg, "a.jpeg")).toMatchObject({ ok: true });
  });

  it.each([
    ["empty", bytes(), "a.png", "empty"],
    ["unsupported", ascii("hello"), "a.png", "unsupported-type"],
    ["a wrong extension", png, "a.pdf", "extension-mismatch"],
    ["no extension", png, "a", "extension-mismatch"],
    ["an unusable name", png, "...", "invalid-name"],
  ])("refuses %s", (_label, input, name, reason) => {
    expect(judgeUpload(input, name)).toMatchObject({ ok: false, reason });
  });

  it("refuses a file over the cap, and accepts one at it", () => {
    const at = new Uint8Array(MAX_FILE_BYTES);
    at.set(png);
    expect(judgeUpload(at, "a.png")).toMatchObject({ ok: true });
    const over = new Uint8Array(MAX_FILE_BYTES + 1);
    over.set(png);
    expect(judgeUpload(over, "a.png")).toMatchObject({
      ok: false,
      reason: "too-large",
    });
  });

  it("refuses an unsafe SVG before it can be stored", () => {
    expect(
      judgeUpload(ascii("<svg><script>x</script></svg>"), "a.svg"),
    ).toMatchObject({ ok: false, reason: "unsafe-svg" });
  });
});

describe("fileResponseHeaders", () => {
  const base = { hash: "a".repeat(64), filename: "a.png", size: 3 };

  it("serves a raster image inline whatever it is loaded as", () => {
    const headers = fileResponseHeaders({
      ...base,
      contentType: "image/png",
      fetchDest: "document",
    });
    expect(headers.get("content-disposition")).toMatch(/^inline;/);
  });

  it("serves an SVG inline only as an image, and always sandboxed", () => {
    const asImage = fileResponseHeaders({
      ...base,
      contentType: "image/svg+xml",
      fetchDest: "image",
    });
    const navigated = fileResponseHeaders({
      ...base,
      contentType: "image/svg+xml",
      fetchDest: "document",
    });
    expect(asImage.get("content-disposition")).toMatch(/^inline;/);
    expect(navigated.get("content-disposition")).toMatch(/^attachment;/);
    expect(navigated.get("content-security-policy")).toContain("sandbox");
  });
});
