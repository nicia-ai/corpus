import { memo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { Card, cardClass } from "@/components/ui/Surface";
import { cn } from "@/lib/cn";
import {
  formatFrontmatterValue,
  parseFrontmatter,
} from "@/store/domain/frontmatter";

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

// slate-100 fill (not the default white card): on the white document ground the
// slate-200 hairline alone is ~1.2:1, so the panel needs a tinted fill to read
// as a distinct metadata block (slate-100 matches the code-block tint).
const FRONTMATTER_PANEL_CLASS = "bg-slate-100 px-6 py-4 sm:px-8";
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
              {formatFrontmatterValue(v)}
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
  bare,
}: Readonly<{
  source: string;
  bodyClassName?: string;
  // Borderless body (no surrounding Card) for the full-page editor's
  // first-paint fallback, so it matches the borderless live-preview surface.
  bare?: boolean;
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
  // `bare` drops the Card (full-page editor surface), aligning the body with
  // the page measure instead of a contained card.
  const bodyCard = bare ? (
    // min-h matches the editor host so the first-paint → editor swap doesn't
    // jump vertically.
    <div className={cn("md min-h-112 py-2", bodyClassName)}>
      <MarkdownContent source={body} />
    </div>
  ) : (
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
