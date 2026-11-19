import { describe, expect, it } from "vitest";

import {
  findSection,
  parseSectionTarget,
  replaceSection,
  sectionUnchanged,
  type SectionTarget,
} from "../src/store/domain/sections";

function target(text: string, level?: number): SectionTarget {
  return { text, level };
}

function spliced(markdown: string, t: SectionTarget, body: string): string {
  const r = replaceSection(markdown, t, body);
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r.markdown;
}

const DOC = [
  "# Hackathon",
  "",
  "Intro paragraph.",
  "",
  "## Guidelines",
  "",
  "Old guideline.",
  "",
  "### Judging",
  "",
  "Nested judging notes.",
  "",
  "## Participants",
  "",
  "- Ada",
  "",
  "## Location",
  "",
  "TBD",
  "",
].join("\n");

describe("parseSectionTarget", () => {
  it("reads plain text, an ATX prefix, and an explicit level", () => {
    expect(
      parseSectionTarget({ heading: "Participants", level: undefined }),
    ).toEqual({
      ok: true,
      target: { text: "Participants", level: undefined },
    });
    expect(
      parseSectionTarget({ heading: "## Participants", level: undefined }),
    ).toEqual({
      ok: true,
      target: { text: "Participants", level: 2 },
    });
    expect(parseSectionTarget({ heading: "Participants", level: "3" })).toEqual(
      {
        ok: true,
        target: { text: "Participants", level: 3 },
      },
    );
  });

  it("rejects blank headings, bad levels, and disagreeing depths", () => {
    expect(parseSectionTarget({ heading: "  ", level: undefined }).ok).toBe(
      false,
    );
    expect(parseSectionTarget({ heading: "A", level: "7" }).ok).toBe(false);
    expect(parseSectionTarget({ heading: "A", level: "x" }).ok).toBe(false);
    expect(parseSectionTarget({ heading: "## A", level: "3" }).ok).toBe(false);
  });
});

describe("replaceSection", () => {
  it("replaces only the target section and preserves every other byte", () => {
    const out = spliced(DOC, target("Participants"), "- Ada\n- Grace");
    expect(out).toBe(DOC.replace("- Ada\n", "- Ada\n- Grace\n"));
    const before = DOC.slice(0, DOC.indexOf("- Ada"));
    const after = DOC.slice(DOC.indexOf("## Location"));
    expect(out.startsWith(before)).toBe(true);
    expect(out.endsWith(after)).toBe(true);
  });

  it("treats nested subsections as part of their parent", () => {
    const out = spliced(DOC, target("Guidelines"), "New guideline.");
    expect(out).not.toContain("Nested judging notes.");
    expect(out).not.toContain("### Judging");
    expect(out).toContain("## Guidelines\n\nNew guideline.\n\n## Participants");
  });

  it("keeps a deeper heading target inside its parent untouched", () => {
    const out = spliced(DOC, target("Judging"), "Updated judging notes.");
    expect(out).toContain(
      "### Judging\n\nUpdated judging notes.\n\n## Participants",
    );
    expect(out).toContain("Old guideline.");
  });

  it("replaces the last section through end of file", () => {
    const out = spliced(DOC, target("Location"), "Pier 9, 6pm");
    expect(out).toBe(DOC.replace("TBD\n", "Pier 9, 6pm\n"));
  });

  it("handles a last section with no trailing newline", () => {
    const out = spliced("# A\n\n## B\n\nold", target("B"), "new");
    expect(out).toBe("# A\n\n## B\n\nnew\n");
  });

  it("appends a missing section at the end, level 2 by default", () => {
    const r = replaceSection(DOC, target("Schedule"), "Friday 6pm");
    expect(r).toEqual({
      ok: true,
      created: true,
      markdown: `${DOC}\n## Schedule\n\nFriday 6pm\n`,
    });
  });

  it("appends at the requested level and from an empty document", () => {
    expect(spliced("", target("Notes", 1), "hello")).toBe("# Notes\n\nhello\n");
    expect(spliced("x", target("Notes", 3), "hi")).toBe(
      "x\n\n### Notes\n\nhi\n",
    );
  });

  it("leaves frontmatter bytes untouched, even when it looks like headings", () => {
    const md = "---\ntitle: Plan\ntags: [a]\n---\n# Plan\n\n## Notes\n\nold\n";
    const out = spliced(md, target("Notes"), "new");
    expect(out).toBe(
      "---\ntitle: Plan\ntags: [a]\n---\n# Plan\n\n## Notes\n\nnew\n",
    );
    const created = spliced(md, target("More"), "x");
    expect(created.startsWith("---\ntitle: Plan\ntags: [a]\n---\n")).toBe(true);
  });

  it("ignores headings inside fenced code blocks", () => {
    const md = "## Real\n\n```sh\n## not a heading\n```\n\n## Next\n\nn\n";
    expect(findSection(md, target("not a heading")).kind).toBe("missing");
    const out = spliced(md, target("Real"), "replaced");
    expect(out).toBe("## Real\n\nreplaced\n\n## Next\n\nn\n");
  });

  it("matches setext headings and preserves their underline", () => {
    const md = "Title\n=====\n\nbody\n\nSub\n---\n\nold\n";
    const out = spliced(md, target("Sub"), "new");
    expect(out).toBe("Title\n=====\n\nbody\n\nSub\n---\n\nnew\n");
  });

  it("matches on heading text with inline markup stripped", () => {
    const md = "## **RSVP** list\n\nold\n";
    expect(spliced(md, target("RSVP list"), "new")).toBe(
      "## **RSVP** list\n\nnew\n",
    );
  });

  it("reports duplicate headings with their lines instead of guessing", () => {
    const md = "## Notes\n\na\n\n## Notes\n\nb\n\n### Notes\n\nc\n";
    expect(replaceSection(md, target("Notes"), "x")).toEqual({
      ok: false,
      reason: "ambiguous",
      matches: [
        { level: 2, line: 1 },
        { level: 2, line: 5 },
        { level: 3, line: 9 },
      ],
    });
    expect(replaceSection(md, target("Notes", 3), "x").ok).toBe(true);
    const r = replaceSection(md, target("Notes", 2), "x");
    expect(r.ok).toBe(false);
  });

  it("rejects a body that would split the section", () => {
    const r = replaceSection(DOC, target("Participants"), "x\n\n## Extra\n\ny");
    expect(r).toMatchObject({ ok: false, reason: "invalid-body" });
    const deeper = replaceSection(
      DOC,
      target("Participants"),
      "x\n\n### Extra\n\ny",
    );
    expect(deeper.ok).toBe(true);
  });

  it("rejects a body that opens a code fence it never closes", () => {
    const r = replaceSection(DOC, target("Guidelines"), "```sh\nrm -rf");
    expect(r).toMatchObject({ ok: false, reason: "invalid-body" });
  });

  it("clears a section with an empty body but keeps its heading", () => {
    expect(spliced(DOC, target("Participants"), "")).toContain(
      "## Participants\n\n## Location",
    );
  });

  it("preserves CRLF documents", () => {
    const md = "## A\r\n\r\nold\r\n\r\n## B\r\n\r\nkeep\r\n";
    expect(spliced(md, target("A"), "new\nline")).toBe(
      "## A\r\n\r\nnew\r\nline\r\n\r\n## B\r\n\r\nkeep\r\n",
    );
  });

  it("is a no-op replace when the body equals the current content", () => {
    expect(spliced(DOC, target("Participants"), "- Ada")).toBe(DOC);
  });
});

describe("sectionUnchanged", () => {
  const same = (before: string, after: string, t: SectionTarget): boolean =>
    sectionUnchanged({ before, after }, t);

  it("is true when a different section changed", () => {
    const edited = spliced(DOC, target("Location"), "Elsewhere");
    expect(same(DOC, edited, target("Participants"))).toBe(true);
    expect(same(DOC, edited, target("Guidelines"))).toBe(true);
  });

  it("is false when the section, or a subsection inside it, changed", () => {
    const location = spliced(DOC, target("Location"), "x");
    expect(same(DOC, location, target("Location"))).toBe(false);
    const judging = spliced(DOC, target("Judging"), "x");
    expect(same(DOC, judging, target("Guidelines"))).toBe(false);
  });

  it("is true when absent from both, false when one side gained it", () => {
    expect(same(DOC, DOC, target("Nope"))).toBe(true);
    const gained = spliced(DOC, target("Nope"), "x");
    expect(same(DOC, gained, target("Nope"))).toBe(false);
  });

  it("is never true for an ambiguous heading", () => {
    const dupes = "## A\n\n## A\n";
    expect(same(dupes, dupes, target("A"))).toBe(false);
  });
});
