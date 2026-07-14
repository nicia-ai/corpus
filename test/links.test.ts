import { describe, expect, it } from "vitest";

import {
  maskCode,
  parseLinks,
  scanWikilinks,
  splitWikiTarget,
} from "../src/store/domain/links";

describe("parseLinks (content-keyed lens)", () => {
  it("keeps relative inline link + image destinations, in order, deduped", () => {
    const md = [
      "See [auth](../api/auth.md) and ![diagram](./img/d.png).",
      "Again [auth](../api/auth.md).",
      "[deep](a/b/c.md#sec) [root](/policies/p.md)",
    ].join("\n");
    expect(parseLinks(md)).toEqual([
      { kind: "path", target: "../api/auth.md" },
      { kind: "path", target: "./img/d.png" },
      { kind: "path", target: "a/b/c.md#sec" },
      { kind: "path", target: "/policies/p.md" },
    ]);
  });

  it("drops absolute URLs, protocol-relative, mailto, and pure anchors", () => {
    const md =
      "[a](https://x.com) [b](http://y) [c](//cdn/z) [d](mailto:x@y.z) [e](#section) [f](tel:+1)";
    expect(parseLinks(md)).toEqual([]);
  });

  it("handles <bracketed> destinations and titles", () => {
    const md = "[a](<../x y.md> \"t\") [b](./z.md 'title')";
    expect(parseLinks(md)).toEqual([
      { kind: "path", target: "../x y.md" },
      { kind: "path", target: "./z.md" },
    ]);
  });

  it("collects reference-style definitions", () => {
    const md = ["[a]: ../ref/one.md", '  [b]:   ./two.md "t"', "[c]: #x"].join(
      "\n",
    );
    expect(parseLinks(md)).toEqual([
      { kind: "path", target: "../ref/one.md" },
      { kind: "path", target: "./two.md" },
    ]);
  });

  it("collects wikilinks: bare, piped, embedded, fragment-stripped, deduped", () => {
    const md = [
      "Start at [[index]] then [[brand-voice|the voice doc]].",
      "Again [[index]] and ![[architecture-diagram]] and [[handbook#Onboarding]].",
    ].join("\n");
    expect(parseLinks(md)).toEqual([
      { kind: "wiki", target: "index" },
      { kind: "wiki", target: "brand-voice" },
      { kind: "wiki", target: "architecture-diagram" },
      { kind: "wiki", target: "handbook" },
    ]);
  });

  it("ignores links and wikilinks inside code fences and inline code", () => {
    const md = [
      "Use `[[page-name]]` (Obsidian wikilinks) for cross-references.",
      "```",
      "[[fenced]] and [fenced](x.md)",
      "```",
      "But [[real]] and [real](y.md) count.",
    ].join("\n");
    expect(parseLinks(md)).toEqual([
      { kind: "path", target: "y.md" },
      { kind: "wiki", target: "real" },
    ]);
  });

  it("returns nothing for link-free prose", () => {
    expect(parseLinks("# Title\n\nJust words.")).toEqual([]);
  });
});

describe("scanWikilinks", () => {
  it("reports exact offsets of each match", () => {
    const text = "a [[x]] b [[y|label]] c";
    expect(scanWikilinks(text)).toEqual([
      { from: 2, to: 7, inner: "x" },
      { from: 10, to: 21, inner: "y|label" },
    ]);
  });

  it("skips empty and bracketed inners", () => {
    expect(scanWikilinks("[[]] [[a[b]] [[\n]]")).toEqual([]);
  });
});

describe("splitWikiTarget", () => {
  it("bare target: label doubles as target, no labelStart", () => {
    expect(splitWikiTarget("release-checklist")).toEqual({
      target: "release-checklist",
      label: "release-checklist",
      labelStart: undefined,
    });
  });

  it("piped label", () => {
    expect(splitWikiTarget("release-checklist|Checklist")).toEqual({
      target: "release-checklist",
      label: "Checklist",
      labelStart: 18,
    });
  });

  it("escaped pipe (GFM table-cell form) splits too", () => {
    expect(splitWikiTarget("brand-voice\\|Voice")).toEqual({
      target: "brand-voice",
      label: "Voice",
      labelStart: 13,
    });
  });

  it("drops the heading fragment from the target", () => {
    expect(splitWikiTarget("handbook#Onboarding").target).toBe("handbook");
    expect(splitWikiTarget("#only-a-heading").target).toBe("");
  });
});

describe("maskCode", () => {
  it("masks fenced blocks and inline spans, preserving every offset", () => {
    const md = "a `x` b\n```js\ncode [[w]]\n```\nafter";
    const masked = maskCode(md);
    expect(masked.length).toBe(md.length);
    expect(masked.split("\n").length).toBe(md.split("\n").length);
    expect(masked).not.toContain("[[w]]");
    expect(masked.startsWith("a    ")).toBe(true);
    expect(masked.endsWith("after")).toBe(true);
  });

  it("an unclosed fence masks to the end", () => {
    expect(maskCode("```\n[[x]]").includes("[[x]]")).toBe(false);
  });

  it("a shorter closing marker does not close a longer fence", () => {
    const masked = maskCode("````\ncode\n```\n[[still-code]]\n````\n[[out]]");
    expect(masked).not.toContain("[[still-code]]");
    expect(masked).toContain("[[out]]");
  });
});
