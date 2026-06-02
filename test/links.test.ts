import { describe, expect, it } from "vitest";

import { parseRelativeLinks } from "../src/store/domain/links";

describe("parseRelativeLinks (content-keyed lens)", () => {
  it("keeps relative inline link + image destinations, in order, deduped", () => {
    const md = [
      "See [auth](../api/auth.md) and ![diagram](./img/d.png).",
      "Again [auth](../api/auth.md).",
      "[deep](a/b/c.md#sec) [root](/policies/p.md)",
    ].join("\n");
    expect(parseRelativeLinks(md)).toEqual([
      "../api/auth.md",
      "./img/d.png",
      "a/b/c.md#sec",
      "/policies/p.md",
    ]);
  });

  it("drops absolute URLs, protocol-relative, mailto, and pure anchors", () => {
    const md =
      "[a](https://x.com) [b](http://y) [c](//cdn/z) [d](mailto:x@y.z) [e](#section) [f](tel:+1)";
    expect(parseRelativeLinks(md)).toEqual([]);
  });

  it("handles <bracketed> destinations and titles", () => {
    const md = "[a](<../x y.md> \"t\") [b](./z.md 'title')";
    expect(parseRelativeLinks(md)).toEqual(["../x y.md", "./z.md"]);
  });

  it("collects reference-style definitions", () => {
    const md = ["[a]: ../ref/one.md", '  [b]:   ./two.md "t"', "[c]: #x"].join(
      "\n",
    );
    expect(parseRelativeLinks(md)).toEqual(["../ref/one.md", "./two.md"]);
  });

  it("returns nothing for link-free prose", () => {
    expect(parseRelativeLinks("# Title\n\nJust words.")).toEqual([]);
  });
});
