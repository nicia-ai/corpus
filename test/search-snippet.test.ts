import { describe, expect, it } from "vitest";

import { headSnippet, searchSnippet } from "@/store/domain/search";

// The snippet contract the UI depends on: matchStart/matchEnd are offsets
// INTO the returned snippet (never the body), whitespace flattening is
// length-preserving so those offsets stay valid, and trimmed edges carry
// an ellipsis the offsets account for.

describe("searchSnippet", () => {
  it("returns the whole body with exact offsets when it fits", () => {
    const body = "alpha beta gamma";
    const cut = searchSnippet(body, body.indexOf("beta"), "beta".length);
    expect(cut.snippet).toBe("alpha beta gamma");
    expect(cut.snippet.slice(cut.matchStart, cut.matchEnd)).toBe("beta");
  });

  it("windows a long body around the match with ellipses", () => {
    const pad = "word ".repeat(50);
    const body = `${pad}NEEDLE${pad}`;
    const cut = searchSnippet(body, pad.length, "NEEDLE".length);
    expect(cut.snippet.startsWith("…")).toBe(true);
    expect(cut.snippet.endsWith("…")).toBe(true);
    expect(cut.snippet.length).toBeLessThan(200);
    expect(cut.snippet.slice(cut.matchStart, cut.matchEnd)).toBe("NEEDLE");
  });

  it("flattens newlines without shifting offsets", () => {
    const body = "line one\nline two\nfind me here\nline four";
    const cut = searchSnippet(body, body.indexOf("find me"), "find me".length);
    expect(cut.snippet).not.toContain("\n");
    expect(cut.snippet.slice(cut.matchStart, cut.matchEnd)).toBe("find me");
  });

  it("never trims into the match itself", () => {
    // A match at the very start of the window: boundary trimming must not
    // move the window start past matchIndex.
    const body = `${"x".repeat(70)} NEEDLE tail`;
    const cut = searchSnippet(body, 71, "NEEDLE".length);
    expect(cut.snippet.slice(cut.matchStart, cut.matchEnd)).toBe("NEEDLE");
  });
});

describe("headSnippet", () => {
  it("returns a short body verbatim with no offsets", () => {
    const cut = headSnippet("short body");
    expect(cut.snippet).toBe("short body");
    expect(cut.matchStart).toBeUndefined();
    expect(cut.matchEnd).toBeUndefined();
  });

  it("trims a long body at a word boundary with a trailing ellipsis", () => {
    const cut = headSnippet("word ".repeat(60));
    expect(cut.snippet.endsWith("…")).toBe(true);
    expect(cut.snippet.length).toBeLessThanOrEqual(122);
  });
});
