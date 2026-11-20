import { describe, expect, it } from "vitest";

import {
  classifyInternalRef,
  type DocRef,
  outsideCorpusMessage,
  pathResolverFor,
  wikiResolverFor,
} from "../src/components/markdown/doc-refs";

const REFS: readonly DocRef[] = [
  { slug: "a-readme", path: "README.md", corpusSlug: "a" },
  { slug: "a-guide", path: "docs/guide.md", corpusSlug: "a" },
  { slug: "b-readme", path: "README.md", corpusSlug: "b" },
  { slug: "b-only", path: "only-b.md", corpusSlug: "b" },
];
const KNOWN = new Map(REFS.map((r) => [r.slug, r.corpusSlug] as const));

describe("editor link diagnostics across corpora", () => {
  it("accepts a link inside the corpus, flags an unknown slug, ignores external and anchor links", () => {
    expect(
      classifyInternalRef("a-guide", KNOWN, "a-readme", "a"),
    ).toBeUndefined();
    expect(classifyInternalRef("nope", KNOWN, "a-readme", "a")).toBe(
      "No document “nope” in this project",
    );
    expect(
      classifyInternalRef("https://example.com", KNOWN, "a-readme", "a"),
    ).toBeUndefined();
    expect(classifyInternalRef("#top", KNOWN, "a-readme", "a")).toBeUndefined();
  });

  it("warns, never errors, on a link that resolves into a different corpus", () => {
    expect(classifyInternalRef("b-only", KNOWN, "a-readme", "a")).toBe(
      outsideCorpusMessage("b-only"),
    );
  });

  it("does not warn about corpora when the editing document's corpus is unknown", () => {
    expect(classifyInternalRef("b-only", KNOWN, "", "")).toBeUndefined();
  });

  it("resolves a wikilink inside the editing document's own corpus first, so both README.md files stay reachable", () => {
    const fromA = wikiResolverFor(REFS, "a-guide", "a");
    const fromB = wikiResolverFor(REFS, "b-only", "b");
    expect(fromA?.("README")).toBe("a-readme");
    expect(fromB?.("README")).toBe("b-readme");
  });

  it("falls through to another corpus when the own corpus has no match, and uses the creating corpus for a document that is not saved yet", () => {
    expect(wikiResolverFor(REFS, "a-guide", "a")?.("only-b")).toBe("b-only");
    expect(wikiResolverFor(REFS, "unsaved", "b")?.("README")).toBe("b-readme");
  });

  it("warns about a markdown link to another corpus whether it is written as a path or as a slug", () => {
    // `[Prod](product.md)` names a PATH; the document's slug is something else.
    const refs: readonly DocRef[] = [
      { slug: "a-guide", path: "guide.md", corpusSlug: "a" },
      { slug: "prod-page", path: "product.md", corpusSlug: "b" },
      { slug: "a-own", path: "own.md", corpusSlug: "a" },
    ];
    const known = new Map(refs.map((r) => [r.slug, r.corpusSlug] as const));
    const resolvePath = pathResolverFor(refs, "a-guide", "a");
    const lint = (href: string) =>
      classifyInternalRef(href, known, "a-guide", "a", resolvePath);
    // As a path, with a slug that has nothing to do with the file name.
    expect(lint("product.md")).toBe(outsideCorpusMessage("product"));
    // As a slug (the web's own link form).
    expect(lint("prod-page")).toBe(outsideCorpusMessage("prod-page"));
    // Inside the corpus, either way: fine.
    expect(lint("own.md")).toBeUndefined();
    expect(lint("a-own")).toBeUndefined();
    // Nowhere: still the broken-link warning.
    expect(lint("missing.md")).toBe("No document “missing” in this project");
  });
});
