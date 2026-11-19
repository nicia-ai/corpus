import { frontmatterLength, processor } from "@nicia-ai/prose-diff";
import type { Heading, Nodes, PhrasingContent } from "mdast";

// Section-scoped edits: the pure, zero-IO splice behind a share link's
// `PUT /s/:token/section`. A section is a top-level heading plus everything
// up to the next top-level heading of the same or a shallower depth, so
// deeper subsections belong to their parent. Boundaries come from the mdast
// parse (headings inside fenced code or blockquotes are not sections) and the
// splice works on SOURCE offsets: every byte outside the target section,
// frontmatter included, is preserved verbatim.

export const DEFAULT_NEW_SECTION_LEVEL = 2;
const MIN_HEADING_LEVEL = 1;
const MAX_HEADING_LEVEL = 6;

const ATX_PREFIX = /^(#{1,6})[ \t]+(.+)$/;
const LEADING_BLANK_LINES = /^(?:[ \t]*\r?\n)+/;
const TRAILING_WHITESPACE = /\s+$/;

export type SectionTarget = Readonly<{
  text: string;
  // Absent: match a heading of any depth; a created section gets level 2.
  level: number | undefined;
}>;

export type SectionTargetParse =
  | Readonly<{ ok: true; target: SectionTarget }>
  | Readonly<{ ok: false; error: string }>;

export type SectionMatch = Readonly<{ level: number; line: number }>;

type Section = Readonly<{
  level: number;
  // Source offset of the heading line.
  start: number;
  // Source offset just past the heading line; the section body starts here.
  headingEnd: number;
  // Source offset where the section ends (next same-or-shallower heading,
  // or the end of the document).
  end: number;
}>;

type HeadingSpan = Readonly<{
  level: number;
  text: string;
  start: number;
  end: number;
}>;

export type SectionLookup =
  | Readonly<{ kind: "found"; section: Section }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "ambiguous"; matches: readonly SectionMatch[] }>;

export type SectionReplacement =
  | Readonly<{ ok: true; markdown: string; created: boolean }>
  | Readonly<{
      ok: false;
      reason: "ambiguous";
      matches: readonly SectionMatch[];
    }>
  | Readonly<{ ok: false; reason: "invalid-body"; error: string }>;

function collapseWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function plainText(node: Nodes | PhrasingContent): string {
  if ("value" in node) return node.value;
  if ("children" in node) return node.children.map(plainText).join("");
  return "";
}

function headingSpans(
  markdown: string,
  bodyOffset: number = frontmatterLength(markdown),
): readonly HeadingSpan[] {
  const tree = processor.parse(markdown.slice(bodyOffset));
  return tree.children
    .filter((node): node is Heading => node.type === "heading")
    .map((node) => ({
      level: node.depth,
      text: collapseWhitespace(plainText(node)),
      start: (node.position?.start.offset ?? 0) + bodyOffset,
      end: (node.position?.end.offset ?? 0) + bodyOffset,
    }));
}

function lineOf(markdown: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i += 1) {
    if (markdown.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

// `heading` is the heading's text ("Participants"); an ATX prefix
// ("## Participants") is accepted and read as the level. `level` is the
// explicit depth. Both given must agree.
export function parseSectionTarget(
  input: Readonly<{ heading: string; level: string | undefined }>,
): SectionTargetParse {
  const prefixed = ATX_PREFIX.exec(input.heading.trim());
  const text = collapseWhitespace(prefixed?.[2] ?? input.heading);
  if (text === "") return { ok: false, error: "heading required" };
  const fromPrefix = prefixed?.[1]?.length;
  const fromParam =
    input.level === undefined || input.level.trim() === ""
      ? undefined
      : Number(input.level);
  if (
    fromParam !== undefined &&
    (!Number.isInteger(fromParam) ||
      fromParam < MIN_HEADING_LEVEL ||
      fromParam > MAX_HEADING_LEVEL)
  ) {
    return { ok: false, error: "level must be an integer from 1 to 6" };
  }
  if (
    fromPrefix !== undefined &&
    fromParam !== undefined &&
    fromPrefix !== fromParam
  ) {
    return { ok: false, error: "heading and level name different depths" };
  }
  return { ok: true, target: { text, level: fromPrefix ?? fromParam } };
}

export function findSection(
  markdown: string,
  target: SectionTarget,
): SectionLookup {
  const headings = headingSpans(markdown);
  const matching = headings.filter(
    (h) =>
      h.text === target.text &&
      (target.level === undefined || h.level === target.level),
  );
  const [first, ...rest] = matching;
  if (first === undefined) return { kind: "missing" };
  if (rest.length > 0) {
    return {
      kind: "ambiguous",
      matches: matching.map((h) => ({
        level: h.level,
        line: lineOf(markdown, h.start),
      })),
    };
  }
  const next = headings.find(
    (h) => h.start > first.start && h.level <= first.level,
  );
  return {
    kind: "found",
    section: {
      level: first.level,
      start: first.start,
      headingEnd: first.end,
      end: next?.start ?? markdown.length,
    },
  };
}

// Whether the target section is the same in two versions of a document: the
// heading line, body, and subsections byte-identical, or absent from both.
// An ambiguous heading in either version is never "the same".
export function sectionUnchanged(
  versions: Readonly<{ before: string; after: string }>,
  target: SectionTarget,
): boolean {
  const before = findSection(versions.before, target);
  const after = findSection(versions.after, target);
  if (before.kind === "missing" && after.kind === "missing") return true;
  if (before.kind !== "found" || after.kind !== "found") return false;
  return (
    versions.before.slice(before.section.start, before.section.end) ===
    versions.after.slice(after.section.start, after.section.end)
  );
}

function lineEnding(markdown: string): string {
  return markdown.includes("\r\n") ? "\r\n" : "\n";
}

function normalizeBody(body: string): string {
  return body.replace(LEADING_BLANK_LINES, "").replace(TRAILING_WHITESPACE, "");
}

function bodyHeadingError(body: string, level: number): string | undefined {
  const shallow = headingSpans(body, 0).find((h) => h.level <= level);
  if (shallow === undefined) return undefined;
  return `section body contains a level-${String(shallow.level)} heading ("${shallow.text}"); a level-${String(level)} section may only contain deeper headings. To add a sibling section, send a separate request for it.`;
}

function headingKey(h: HeadingSpan): string {
  return `${String(h.level)}:${h.text}`;
}

// A section body is never frontmatter, so it is parsed from offset 0.
function bodyHeadingKeys(content: string): readonly string[] {
  return headingSpans(content, 0).map(headingKey);
}

// Replace (or append) one section's content. Everything outside
// [headingEnd, end) is untouched; the heading line itself is preserved.
export function replaceSection(
  markdown: string,
  target: SectionTarget,
  body: string,
): SectionReplacement {
  const lookup = findSection(markdown, target);
  if (lookup.kind === "ambiguous") {
    return { ok: false, reason: "ambiguous", matches: lookup.matches };
  }
  const level =
    lookup.kind === "found"
      ? lookup.section.level
      : (target.level ?? DEFAULT_NEW_SECTION_LEVEL);
  const eol = lineEnding(markdown);
  const content = normalizeBody(body).replace(/\r?\n/g, eol);
  const shallow = bodyHeadingError(content, level);
  if (shallow !== undefined) {
    return { ok: false, reason: "invalid-body", error: shallow };
  }
  const result =
    lookup.kind === "found"
      ? spliceExisting(markdown, lookup.section, content, eol)
      : appendSection(markdown, { level, text: target.text }, content, eol);
  if (
    !structureIntact(markdown, result, {
      lookup,
      level,
      text: target.text,
      content,
    })
  ) {
    return {
      ok: false,
      reason: "invalid-body",
      error:
        "section body would change the structure of the rest of the page (for example an unclosed code fence). Close it and retry.",
    };
  }
  return { ok: true, markdown: result, created: lookup.kind === "missing" };
}

function spliceExisting(
  markdown: string,
  section: Section,
  content: string,
  eol: string,
): string {
  const gap = content === "" ? eol : `${eol}${eol}${content}${eol}`;
  const trailer = section.end < markdown.length ? eol : "";
  return `${markdown.slice(0, section.headingEnd)}${gap}${trailer}${markdown.slice(section.end)}`;
}

function appendSection(
  markdown: string,
  heading: Readonly<{ level: number; text: string }>,
  content: string,
  eol: string,
): string {
  const separator =
    markdown === ""
      ? ""
      : markdown.endsWith(`${eol}${eol}`)
        ? ""
        : markdown.endsWith(eol)
          ? eol
          : `${eol}${eol}`;
  const line = `${"#".repeat(heading.level)} ${heading.text}`;
  const tail = content === "" ? eol : `${eol}${eol}${content}${eol}`;
  return `${markdown}${separator}${line}${tail}`;
}

// The splice must leave the page's heading outline exactly as: the headings
// up to and including the section's own, the body's headings, then the
// headings after the section. A body that opens a code fence it never closes
// would swallow the following sections; this catches that instead of saving it.
function structureIntact(
  before: string,
  after: string,
  plan: Readonly<{
    lookup: SectionLookup;
    level: number;
    text: string;
    content: string;
  }>,
): boolean {
  const old = headingSpans(before);
  const { lookup } = plan;
  const head =
    lookup.kind === "found"
      ? old.filter((h) => h.start <= lookup.section.start).map(headingKey)
      : [...old.map(headingKey), `${String(plan.level)}:${plan.text}`];
  const tail =
    lookup.kind === "found"
      ? old.filter((h) => h.start >= lookup.section.end).map(headingKey)
      : [];
  const expected = [...head, ...bodyHeadingKeys(plan.content), ...tail];
  const actual = headingSpans(after).map(headingKey);
  return (
    expected.length === actual.length &&
    expected.every((key, i) => key === actual[i])
  );
}
