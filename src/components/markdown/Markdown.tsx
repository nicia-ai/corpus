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
import { scanWikilinks, splitWikiTarget } from "@/store/domain/links";

import { type ImageAssets, resolveImageSource } from "./image-assets";
import type { WikiResolve } from "./inline-spans";

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
const FRONTMATTER_PANEL_CLASS = "bg-slate-100 px-6! py-4! sm:px-8!";
export const DOCUMENT_BODY_CLASS =
  "md min-h-[calc(100vh-15rem)] px-6! py-8! sm:px-10! sm:py-10! lg:px-14! lg:py-12!";

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
  wikiResolve,
  assets,
  onFollowLink,
}: Readonly<{
  source: string;
  bodyClassName?: string;
  // Borderless body (no surrounding Card) for the full-page editor's
  // first-paint fallback, so it matches the borderless live-preview surface.
  bare?: boolean;
  wikiResolve?: WikiResolve | undefined;
  // The stored files relative images resolve to. Without it relative images
  // render as written (history and diffs have no page to resolve against).
  assets?: ImageAssets | undefined;
  onFollowLink?: ((href: string) => void) | undefined;
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
      <MarkdownContent
        source={body}
        wikiResolve={wikiResolve}
        assets={assets}
        onFollowLink={onFollowLink}
      />
    </div>
  ) : (
    <div className={cardClass(cn(DOCUMENT_BODY_CLASS, bodyClassName))}>
      <MarkdownContent
        source={body}
        wikiResolve={wikiResolve}
        assets={assets}
        onFollowLink={onFollowLink}
      />
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

// Re-exported for callers wiring a resolver into a rendered surface;
// optional everywhere: without it (history, diffs) wikilinks stay
// literal text, exactly as remark parses them.
export type { WikiResolve } from "./inline-spans";

// Minimal structural mdast view — enough for the text-node walk below
// without depending on @types/mdast (a transitive dep of react-markdown).
type MdastNode = Readonly<{
  type: string;
  value?: string;
  url?: string;
  children?: readonly MdastNode[];
}>;

// Split one text node around its RESOLVED wikilinks: `[[target|label]]`
// becomes a link to the resolved slug with the label (or target) as its
// text; unresolved matches stay literal (the editor's linter is the
// surface that flags those). remark leaves `[[…]]` as plain text — a
// shortcut reference without a definition never becomes a node — so the
// text-node scan sees every wikilink intact.
function splitWikiText(
  value: string,
  resolve: WikiResolve,
): readonly MdastNode[] {
  const out: MdastNode[] = [];
  let pos = 0;
  for (const m of scanWikilinks(value)) {
    const { target, label } = splitWikiTarget(m.inner);
    const slug = target === "" ? undefined : resolve(target);
    if (slug === undefined) continue;
    if (m.from > pos)
      out.push({ type: "text", value: value.slice(pos, m.from) });
    out.push({
      type: "link",
      url: slug,
      children: [{ type: "text", value: label }],
    });
    pos = m.to;
  }
  if (out.length === 0) return [{ type: "text", value }];
  if (pos < value.length) out.push({ type: "text", value: value.slice(pos) });
  return out;
}

const WIKI_SKIP = new Set(["code", "inlineCode"]);

// Pure rebuild — remark accepts a transformer that RETURNS the new tree,
// so no mdast node is ever mutated in place.
function remarkWikilinks(resolve: WikiResolve): (tree: MdastNode) => MdastNode {
  const transform = (node: MdastNode): MdastNode => {
    if (node.children === undefined) return node;
    const children = node.children.flatMap((child): readonly MdastNode[] => {
      if (child.type === "text" && typeof child.value === "string") {
        return splitWikiText(child.value, resolve);
      }
      return [WIKI_SKIP.has(child.type) ? child : transform(child)];
    });
    return { ...node, children };
  };
  return transform;
}

// A relative image resolved through the stored-file map, or a plain
// placeholder when no stored file answers to it (the same rule the editor's
// live preview applies; see ./image-assets).
function ResolvedImage({
  src,
  alt,
  assets,
}: Readonly<{
  src: string | undefined;
  alt: string | undefined;
  assets: ImageAssets;
}>): React.ReactElement | null {
  if (src === undefined) return null;
  const source = resolveImageSource(assets, src);
  switch (source.kind) {
    case "external":
      return <img src={source.src} alt={alt ?? ""} loading="lazy" />;
    case "image":
      return <img src={source.asset.url} alt={alt ?? ""} loading="lazy" />;
    case "file":
      return (
        <a href={source.asset.url} target="_blank" rel="noopener">
          {alt === undefined || alt === "" ? source.asset.name : alt}
        </a>
      );
    case "missing":
      return (
        <span
          className="inline-flex max-w-full items-center rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-500 [overflow-wrap:anywhere]"
          title={`No file named ${source.name} is stored beside this page.`}
        >
          Missing image: {source.name}
        </span>
      );
  }
}

export function MarkdownContent({
  source,
  wikiResolve,
  assets,
  onFollowLink,
}: Readonly<{
  source: string;
  wikiResolve?: WikiResolve | undefined;
  assets?: ImageAssets | undefined;
  onFollowLink?: ((href: string) => void) | undefined;
}>): React.ReactElement {
  return (
    <ReactMarkdown
      remarkPlugins={[
        remarkGfm,
        ...(wikiResolve === undefined
          ? []
          : [() => remarkWikilinks(wikiResolve)]),
      ]}
      rehypePlugins={[rehypeSanitize]}
      components={{
        ...(onFollowLink === undefined
          ? {}
          : {
              a: ({ href, children }) => (
                <a
                  href={href}
                  onClick={(event) => {
                    if (href === undefined) return;
                    event.preventDefault();
                    onFollowLink(href);
                  }}
                >
                  {children}
                </a>
              ),
            }),
        ...(assets === undefined
          ? {}
          : {
              img: ({ src, alt }) => (
                <ResolvedImage
                  src={typeof src === "string" ? src : undefined}
                  alt={alt}
                  assets={assets}
                />
              ),
            }),
      }}
    >
      {source}
    </ReactMarkdown>
  );
}
