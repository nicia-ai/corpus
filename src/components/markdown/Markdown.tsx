import { memo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { Card, cardClass } from "@/components/ui/Surface";
import { cn } from "@/lib/cn";
import { parseFrontmatter } from "@/store/domain/frontmatter";

// The reader-first surface: canonical documents are authored by non-engineers
// and read far more than edited, so the rendered view is the default. GFM
// (tables, task lists, strikethrough, autolinks) covers what these documents
// actually use; rehype-sanitize runs the GitHub schema over the HAST so a
// document authored by one org member can never inject markup into another's
// view (authored input is post-auth but still untrusted across members).
// Element typography lives in the `.md` block in styles.css, expressed in
// DESIGN.md tokens — not inline classes — so the read and preview surfaces
// stay byte-identical and the design system has one place to change.
//
// Frontmatter is split out HERE (not in the editor): authors paste whole
// files including the `---` fence and must keep editing them as one
// document, but every rendered surface (read, preview, history) shows the
// metadata as its own panel above the body. A malformed fence mid-edit in
// the Preview tab falls back to rendering the raw source verbatim — the
// save path is what rejects it, the preview never blanks.

function formatValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(formatValue).join(", ");
  if (v === null || v === undefined) return "";
  return JSON.stringify(v);
}

const FRONTMATTER_PANEL_CLASS = "px-6 py-4 sm:px-8";
export const DOCUMENT_BODY_CLASS =
  "md min-h-[calc(100vh-15rem)] px-6 py-8 sm:px-10 sm:py-10 lg:px-14 lg:py-12";

// A faint tint inside the white body card read as a smudge; merging onto the
// same surface read as no separation at all. So metadata is its OWN panel —
// a sibling white Card, separated from the body by the page-bg gap (the
// app's standard surface-vs-surface separation), with an uppercase eyebrow.
function FrontmatterPanel({
  entries,
}: Readonly<{ entries: readonly (readonly [string, unknown])[] }>) {
  return (
    <Card className={FRONTMATTER_PANEL_CLASS}>
      <div className="mb-2 text-sm font-medium tracking-wide text-slate-500 uppercase">
        Metadata
      </div>
      <dl className="grid grid-cols-[minmax(6rem,max-content)_1fr] gap-x-4 gap-y-1 text-base">
        {entries.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="font-medium text-slate-500 tabular-nums">{k}</dt>
            <dd className="text-slate-900 [overflow-wrap:anywhere]">
              {formatValue(v)}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

// Memoized: in Preview the source changes per keystroke, but unrelated
// parent re-renders (broken-link count, tab state) must not re-run the
// frontmatter parse + remark→rehype→sanitize parse.
export const Markdown = memo(function Markdown({
  source,
  bodyClassName,
}: Readonly<{
  source: string;
  bodyClassName?: string;
}>): React.ReactElement {
  const fm = parseFrontmatter(source);
  const body = fm.ok ? fm.body : source;
  const entries =
    fm.ok && fm.frontmatter !== undefined
      ? Object.entries(fm.frontmatter)
      : undefined;

  // Markdown owns the surface: the body is its own `.md`-typed Card. When
  // there's frontmatter, the metadata Card stacks above it with a page-bg
  // gap (`space-y`), so the two read as distinct panels, not one tinted box.
  const bodyCard = (
    <div className={cardClass(cn(DOCUMENT_BODY_CLASS, bodyClassName))}>
      <MarkdownContent source={body} />
    </div>
  );

  if (entries === undefined) return bodyCard;

  return (
    <div className="space-y-4">
      <FrontmatterPanel entries={entries} />
      {bodyCard}
    </div>
  );
});

export function MarkdownContent({
  source,
}: Readonly<{
  source: string;
}>): React.ReactElement {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
      {source}
    </ReactMarkdown>
  );
}
