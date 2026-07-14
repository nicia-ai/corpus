import { parse as parseYaml } from "yaml";

import { inferTitle } from "../../util";

// Pure, zero-IO split of a leading YAML frontmatter fence from a markdown
// document. The fence is the on-disk convention these files arrive with
// (Obsidian / Jekyll / static-site authoring): a `---` line at byte 0, a
// YAML mapping, a closing `---` line, then the body.
//
// The canonical artifact is always the whole file (frontmatter included) —
// this never mutates stored content or the content hash. It is a read-time
// lens used in exactly three places: save-time validation (reject a
// malformed fence at the transport edge), the `read_document_meta` MCP tool,
// and the rendered web view (panel above the body). The editor and
// `read_document` keep the file as one verbatim blob.

export type Frontmatter = Readonly<Record<string, unknown>>;

export type FrontmatterParse =
  | Readonly<{ ok: true; frontmatter: Frontmatter | undefined; body: string }>
  | Readonly<{ ok: false; error: string }>;

// Opening fence: `---` as the entire first line (trailing spaces/tabs and
// either newline style tolerated). Recognized ONLY at byte 0 — a `---`
// thematic break elsewhere in the document is content, never a fence.
const OPEN = /^---[ \t]*\r?\n/;
// Closing fence after the opener: a `---`-only line, either immediately
// (empty frontmatter) or after a newline. Ends at the next newline or EOF.
const CLOSE_AT_START = /^---[ \t]*(?:\r?\n|$)/;
const CLOSE_AFTER = /\r?\n---[ \t]*(?:\r?\n|$)/;

function plain(raw: string): FrontmatterParse {
  return { ok: true, frontmatter: undefined, body: raw };
}

function isMapping(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseFrontmatter(raw: string): FrontmatterParse {
  const open = OPEN.exec(raw);
  if (open === null) return plain(raw);

  const rest = raw.slice(open[0].length);

  let yamlText: string;
  let body: string;
  const atStart = CLOSE_AT_START.exec(rest);
  if (atStart !== null) {
    yamlText = "";
    body = rest.slice(atStart[0].length);
  } else {
    const close = CLOSE_AFTER.exec(rest);
    // An unterminated opener is not a fence — treat the whole document as
    // body so a stray leading `---` (or a paste-in-progress) never blocks
    // a save or hides content.
    if (close === null) return plain(raw);
    yamlText = rest.slice(0, close.index);
    body = rest.slice(close.index + close[0].length);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  // Empty / whitespace-only frontmatter is "no metadata", not an error.
  if (parsed === null || parsed === undefined) {
    return { ok: true, frontmatter: undefined, body };
  }
  if (!isMapping(parsed)) {
    return { ok: false, error: "frontmatter must be a YAML mapping" };
  }
  return {
    ok: true,
    frontmatter: Object.keys(parsed).length === 0 ? undefined : parsed,
    body,
  };
}

// The display title carried in frontmatter, if any. `title` is the
// near-universal convention (Obsidian / Jekyll / Hugo); a non-empty
// string wins, anything else is ignored.
export function frontmatterTitle(
  fm: Frontmatter | undefined,
): string | undefined {
  const t = fm?.title;
  return typeof t === "string" && t.trim() !== "" ? t.trim() : undefined;
}

// The resolved display title for a markdown document: an explicit override
// wins, else the frontmatter `title`, else the first H1, else the caller's
// fallback (typically the slug or filename stem). Single source for both the
// save path and the create-proposal preview, so a proposal previews under the
// exact title its applied document will get.
export function resolveTitle(
  input: Readonly<{
    markdown: string;
    fallback: string;
    override?: string | undefined;
  }>,
): string {
  const parsed = parseFrontmatter(input.markdown);
  const body = parsed.ok ? parsed.body : input.markdown;
  const fmTitle = parsed.ok ? frontmatterTitle(parsed.frontmatter) : undefined;
  return input.override ?? fmTitle ?? inferTitle(body, input.fallback);
}

// Format a frontmatter value for display in the metadata panel. Shared by
// the rendered Markdown surface (Markdown.tsx) and the editor's live-preview
// frontmatter widget (block-widgets.ts) so the two panels render identically.
export function formatFrontmatterValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(formatFrontmatterValue).join(", ");
  if (v === null || v === undefined) return "";
  return JSON.stringify(v);
}
