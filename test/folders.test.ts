import { describe, expect, it } from "vitest";

import {
  appendPosition,
  isSelfOrAncestor,
  type SiblingSegment,
  segmentCollides,
  wouldCreateCycle,
} from "../src/store/domain/folders";

const siblings: readonly SiblingSegment[] = [
  { kind: "folder", slug: "f-docs", segment: "docs" },
  { kind: "document", slug: "d-readme", segment: "readme.md" },
];

describe("segmentCollides (cross-type sibling namespace)", () => {
  it("collides on an existing folder name", () => {
    expect(segmentCollides(siblings, "docs")).toBe(true);
  });

  it("collides on an existing document filename", () => {
    expect(segmentCollides(siblings, "readme.md")).toBe(true);
  });

  it("does not collide on a free segment", () => {
    expect(segmentCollides(siblings, "guide")).toBe(false);
  });

  it("excludes self (rename a folder in place is allowed)", () => {
    expect(
      segmentCollides(siblings, "docs", { kind: "folder", slug: "f-docs" }),
    ).toBe(false);
  });

  it("self-exclusion is type-aware: a same-slug node of the OTHER kind still collides", () => {
    // A Folder and a Document may share a slug string (independent
    // TypeGraph unique scopes). Placing doc "foo" must still collide
    // with folder "foo" even though both have slug "foo".
    const shared: readonly SiblingSegment[] = [
      { kind: "folder", slug: "foo", segment: "foo" },
      { kind: "document", slug: "foo", segment: "foo" },
    ];
    expect(
      segmentCollides(shared, "foo", { kind: "document", slug: "foo" }),
    ).toBe(true);
  });
});

describe("isSelfOrAncestor / wouldCreateCycle", () => {
  // root → a → b → c
  const parents = new Map<string, string | null>([
    ["a", null],
    ["b", "a"],
    ["c", "b"],
  ]);

  it("a node is its own ancestor (self)", () => {
    expect(isSelfOrAncestor("b", "b", parents)).toBe(true);
  });

  it("detects a transitive ancestor", () => {
    expect(isSelfOrAncestor("a", "c", parents)).toBe(true);
  });

  it("is false for an unrelated node", () => {
    expect(isSelfOrAncestor("c", "a", parents)).toBe(false);
  });

  it("moving a folder under its own descendant is a cycle", () => {
    expect(wouldCreateCycle("a", "c", parents)).toBe(true);
  });

  it("moving to root (null) is always safe", () => {
    expect(wouldCreateCycle("a", null, parents)).toBe(false);
  });

  it("moving to an unrelated subtree is allowed", () => {
    const p = new Map<string, string | null>([
      ["a", null],
      ["x", null],
    ]);
    expect(wouldCreateCycle("a", "x", p)).toBe(false);
  });

  it("a broken/missing parent link terminates the walk", () => {
    const p = new Map<string, string | null>([["c", "missing"]]);
    expect(isSelfOrAncestor("a", "c", p)).toBe(false);
  });
});

describe("sibling ordering", () => {
  it("appendPosition is max + 1, 1-based for an empty parent", () => {
    expect(appendPosition([])).toBe(1);
    expect(appendPosition([1, 2, 3])).toBe(4);
    expect(appendPosition([1, 5])).toBe(6);
  });
});
