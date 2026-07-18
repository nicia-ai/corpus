import { describe, expect, it } from "vitest";

import {
  documentWithStarterFrontmatter,
  hasFrontmatterFence,
  parseFrontmatter,
} from "../src/store/domain/frontmatter";

describe("parseFrontmatter (pure read-time lens)", () => {
  it("passes a fence-less document through untouched", () => {
    const raw = "# Title\n\njust body, no fence\n";
    const r = parseFrontmatter(raw);
    expect(r).toEqual({ ok: true, frontmatter: undefined, body: raw });
  });

  it("splits a valid leading fence from the body", () => {
    const r = parseFrontmatter(
      "---\ntitle: Onboarding\ntags:\n  - ops\n  - sales\n---\n# Heading\n\nbody\n",
    );
    expect(r).toEqual({
      ok: true,
      frontmatter: { title: "Onboarding", tags: ["ops", "sales"] },
      body: "# Heading\n\nbody\n",
    });
  });

  it("tolerates CRLF newlines", () => {
    const r = parseFrontmatter("---\r\na: 1\r\n---\r\nbody\r\n");
    expect(r).toEqual({ ok: true, frontmatter: { a: 1 }, body: "body\r\n" });
  });

  it("treats an empty fence as no metadata", () => {
    const r = parseFrontmatter("---\n---\nbody\n");
    expect(r).toEqual({ ok: true, frontmatter: undefined, body: "body\n" });
  });

  it("treats a whitespace/comment-only fence as no metadata", () => {
    const r = parseFrontmatter("---\n# just a comment\n\n---\nbody\n");
    expect(r).toEqual({ ok: true, frontmatter: undefined, body: "body\n" });
  });

  it("preserves body bytes verbatim, including a later --- break", () => {
    const r = parseFrontmatter("---\nk: v\n---\nintro\n\n---\n\nmore\n");
    expect(r).toEqual({
      ok: true,
      frontmatter: { k: "v" },
      body: "intro\n\n---\n\nmore\n",
    });
  });

  it("rejects a non-mapping scalar fence", () => {
    const r = parseFrontmatter("---\njust a string\n---\nbody\n");
    expect(r.ok).toBe(false);
  });

  it("rejects a sequence (array) fence", () => {
    const r = parseFrontmatter("---\n- one\n- two\n---\nbody\n");
    expect(r.ok).toBe(false);
  });

  it("rejects malformed YAML with the parser's message", () => {
    const r = parseFrontmatter("---\nfoo: [unclosed\n---\nbody\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });

  it("ignores a fence not at byte 0 (leading blank line)", () => {
    const raw = "\n---\na: 1\n---\nbody\n";
    expect(parseFrontmatter(raw)).toEqual({
      ok: true,
      frontmatter: undefined,
      body: raw,
    });
  });

  it("treats an unterminated opener as plain content", () => {
    const raw = "---\nstill typing the frontmatter\n";
    expect(parseFrontmatter(raw)).toEqual({
      ok: true,
      frontmatter: undefined,
      body: raw,
    });
  });

  it("does not treat a mid-document --- as an opener", () => {
    const raw = "intro\n\n---\n\nkey: not-frontmatter\n";
    expect(parseFrontmatter(raw)).toEqual({
      ok: true,
      frontmatter: undefined,
      body: raw,
    });
  });
});

describe("documentWithStarterFrontmatter (Add-metadata insertion)", () => {
  const CARET = "---\ntitle: ".length; // right after "title: "

  it("seeds a title fence with one blank line before an empty body", () => {
    const { text, caret } = documentWithStarterFrontmatter("");
    expect(text).toBe("---\ntitle: \n---\n\n");
    expect(caret).toBe(CARET);
    expect(text.slice(0, caret)).toBe("---\ntitle: ");
  });

  it("wraps an existing body with exactly one separating blank line", () => {
    const { text } = documentWithStarterFrontmatter("# Heading\n\nbody\n");
    expect(text).toBe("---\ntitle: \n---\n\n# Heading\n\nbody\n");
  });

  it("folds away the body's leading blank lines (no double gap)", () => {
    const { text } = documentWithStarterFrontmatter("\n\n\nbody");
    expect(text).toBe("---\ntitle: \n---\n\nbody");
  });

  it("produces a document the parser recognizes as frontmatter", () => {
    // The seeded fence must round-trip: both entry points rely on the inserted
    // text parsing back as a real (empty-valued) `title` key.
    const { text } = documentWithStarterFrontmatter("existing body");
    const parsed = parseFrontmatter(text);
    // The blank line separating the closing fence from the body is body bytes.
    expect(parsed).toEqual({
      ok: true,
      frontmatter: { title: null },
      body: "\nexisting body",
    });
    expect(hasFrontmatterFence(text)).toBe(true);
  });
});

describe("hasFrontmatterFence (Add-metadata affordance gate)", () => {
  it("is false for a fence-less document", () => {
    expect(hasFrontmatterFence("# Title\n\nbody")).toBe(false);
  });

  it("is false for an unterminated opener (no closing ---)", () => {
    expect(hasFrontmatterFence("---\nstill typing\n")).toBe(false);
  });

  // A fence EXISTS in all three of the next cases, so the button hides and the
  // insert is blocked — the button gate and the no-stack guard agree, so a
  // keyless/malformed fence can neither show a dead button nor be double-fenced.
  it("is true for an empty (keyless) fence", () => {
    expect(hasFrontmatterFence("---\n---\nbody")).toBe(true);
  });

  it("is true for a malformed fence (a non-mapping scalar)", () => {
    expect(hasFrontmatterFence("---\njust a string\n---\nbody")).toBe(true);
  });

  it("is true for a keyed fence", () => {
    expect(hasFrontmatterFence("---\ntitle: Hi\n---\nbody")).toBe(true);
  });
});
