import { describe, expect, it } from "vitest";

import {
  basename,
  defaultFilename,
  derivePath,
  normalizeSlug,
  pathSegments,
  resolveRelativePath,
  resolveWikiPath,
} from "../src/store/domain/paths";

const NONE: ReadonlySet<string> = new Set();

describe("pathSegments / basename", () => {
  it("splits a relative path into clean segments", () => {
    expect(pathSegments("guide/setup.md")).toEqual(["guide", "setup.md"]);
  });

  it("tolerates leading ./, repeated/leading/trailing slashes, backslashes", () => {
    expect(pathSegments("./a//b\\c.md/")).toEqual(["a", "b", "c.md"]);
    expect(pathSegments("///")).toEqual([]);
  });

  it("basename is the final segment, extension included", () => {
    expect(basename("a/b/api-auth.md")).toBe("api-auth.md");
    expect(basename("")).toBe("");
  });
});

describe("defaultFilename", () => {
  it("is <slug>.md", () => {
    expect(defaultFilename("brand-voice")).toBe("brand-voice.md");
  });
});

describe("derivePath", () => {
  it("joins ancestor folder names then filename", () => {
    expect(derivePath(["guide", "sub"], "setup.md")).toBe("guide/sub/setup.md");
  });

  it("a root document's path is just its filename", () => {
    expect(derivePath([], "readme.md")).toBe("readme.md");
  });
});

describe("normalizeSlug", () => {
  it("slugifies segments, drops the final extension, joins with -", () => {
    expect(normalizeSlug("guide/setup.md", NONE)).toBe("guide-setup");
  });

  it("gives distinct stable slugs to path variants that would collide", () => {
    const taken = new Set<string>();
    const s1 = normalizeSlug("a/b.md", taken);
    taken.add(s1);
    const s2 = normalizeSlug("a-b.md", taken);
    taken.add(s2);
    const s3 = normalizeSlug("a/b", taken);
    taken.add(s3);
    expect([s1, s2, s3]).toEqual(["a-b", "a-b-2", "a-b-3"]);
    expect(new Set([s1, s2, s3]).size).toBe(3);
  });

  it("is deterministic for the same input + taken set", () => {
    const taken = new Set(["a-b"]);
    expect(normalizeSlug("a/b.md", taken)).toBe(normalizeSlug("a/b.md", taken));
  });

  it("falls back to a deterministic doc-<hash> for an empty path", () => {
    const a = normalizeSlug("///", NONE);
    const b = normalizeSlug("///", NONE);
    expect(a).toBe(b);
    expect(a.startsWith("doc-")).toBe(true);
  });

  it("never contains a slash (flat by construction)", () => {
    expect(normalizeSlug("deep/nested/path/file.md", NONE)).not.toContain("/");
  });
});

describe("resolveRelativePath", () => {
  const src = "a/guide/setup.md";

  it("resolves a same-folder link", () => {
    expect(resolveRelativePath(src, "./intro.md")).toBe("a/guide/intro.md");
    expect(resolveRelativePath(src, "intro.md")).toBe("a/guide/intro.md");
  });

  it("resolves a sibling-folder link", () => {
    expect(resolveRelativePath(src, "../api/auth.md")).toBe("a/api/auth.md");
  });

  it("resolves a parent / deep relative link", () => {
    expect(resolveRelativePath(src, "../../top.md")).toBe("top.md");
    expect(resolveRelativePath(src, "../api/v2/spec.md")).toBe(
      "a/api/v2/spec.md",
    );
  });

  it("strips the fragment (anchors don't select a document)", () => {
    expect(resolveRelativePath(src, "../api/auth.md#section")).toBe(
      "a/api/auth.md",
    );
  });

  it("treats a leading slash as project-root absolute", () => {
    expect(resolveRelativePath(src, "/policies/p.md")).toBe("policies/p.md");
  });

  it("returns undefined for a pure anchor or escape past the root", () => {
    expect(resolveRelativePath(src, "#section")).toBeUndefined();
    expect(resolveRelativePath("readme.md", "../x.md")).toBeUndefined();
    expect(resolveRelativePath(src, "")).toBeUndefined();
  });
});

describe("resolveWikiPath", () => {
  const paths = [
    "wiki/index.md",
    "wiki/brand-voice.md",
    "raw/nicia-spec.md",
    "notes/nicia-spec.md",
    "top.md",
  ];

  it("matches a bare name by basename sans extension", () => {
    expect(resolveWikiPath("wiki/index.md", "brand-voice", paths)).toBe(
      "wiki/brand-voice.md",
    );
    expect(resolveWikiPath("top.md", "top", paths)).toBe("top.md");
  });

  it("prefers the source document's own folder on ambiguity", () => {
    expect(resolveWikiPath("raw/other.md", "nicia-spec", paths)).toBe(
      "raw/nicia-spec.md",
    );
    expect(resolveWikiPath("notes/other.md", "nicia-spec", paths)).toBe(
      "notes/nicia-spec.md",
    );
  });

  it("breaks remaining ties by depth then lexicographic path", () => {
    expect(resolveWikiPath("top.md", "nicia-spec", paths)).toBe(
      "notes/nicia-spec.md",
    );
  });

  it("a target containing / is a project-root path, extension optional", () => {
    expect(resolveWikiPath("top.md", "wiki/index", paths)).toBe(
      "wiki/index.md",
    );
    expect(resolveWikiPath("top.md", "wiki/index.md", paths)).toBe(
      "wiki/index.md",
    );
  });

  it("returns undefined when nothing matches (case-sensitive)", () => {
    expect(resolveWikiPath("top.md", "missing", paths)).toBeUndefined();
    expect(resolveWikiPath("top.md", "Index", paths)).toBeUndefined();
    expect(resolveWikiPath("top.md", "", paths)).toBeUndefined();
  });
});
