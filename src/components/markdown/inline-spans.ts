// Pure inline-markdown span extraction from an already-parsed Lezer
// syntax tree. The live-preview table widget renders GFM table cells
// from this model instead of raw cell text, so `**bold**`, `` `code` ``,
// ~~strikethrough~~, links, and images render inside cells exactly as
// they do in body prose — and stay in agreement with remark-gfm (the
// read view's renderer for the same document), which parses cell
// content as inline markdown. Zero IO and zero DOM: the tree walk
// produces a plain span model (unit-tested directly); the DOM builder
// lives with the widgets in block-widgets.ts.

// Minimal structural view of a Lezer SyntaxNode. @lezer/common is a
// transitive dep that pnpm doesn't hoist (see the same note in
// live-preview.ts), and a structural type also lets tests feed nodes
// from `markdownLanguage.parser.parse(...)` without caring which module
// instance produced them. `null` mirrors the library's API shape.
export type InlineNode = Readonly<{
  name: string;
  from: number;
  to: number;
  firstChild: InlineNode | null;
  nextSibling: InlineNode | null;
  getChild(type: string): InlineNode | null;
  getChildren(type: string): readonly InlineNode[];
}>;

// Text access by absolute offsets — a CodeMirror `Text` slice in the
// editor, a plain `String.slice` in tests.
export type SliceText = (from: number, to: number) => string;

export type InlineSpan =
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "code"; text: string }>
  | Readonly<{ kind: "image"; src: string; alt: string }>
  | Readonly<{
      kind: "strong" | "em" | "del";
      children: readonly InlineSpan[];
    }>
  | Readonly<{ kind: "link"; href: string; children: readonly InlineSpan[] }>;

const CONTAINER_KIND: Readonly<Record<string, "strong" | "em" | "del">> = {
  StrongEmphasis: "strong",
  Emphasis: "em",
  Strikethrough: "del",
};

// Delimiter tokens whose characters must not leak into the rendered
// output when their container is handled (`**`, `` ` ``, `~~`).
// LinkMark is deliberately absent: for a link WITHOUT a destination
// (`[shortcut ref]`), CommonMark renders the brackets literally, so its
// marks must flow through as text.
const SKIP_MARKS: ReadonlySet<string> = new Set([
  "EmphasisMark",
  "CodeMark",
  "StrikethroughMark",
]);

// A destination link's href plus the [labelFrom, labelTo) range of its
// label — between the `[` opener and the `]` closer. Shared by the
// table-cell walker (spanFor) and live-preview's decorateLink so the two
// readers agree on link geometry. Undefined for a reference / bracket-only
// link (no URL child) or malformed delimiters; the caller renders those
// literally. A URL-bearing Link's LinkMark children are exactly `[ ] ( )`,
// so the `]` closer is always the second — index it directly.
export type LinkParts = Readonly<{
  href: string;
  labelFrom: number;
  labelTo: number;
}>;

export function linkParts(
  slice: SliceText,
  node: InlineNode,
): LinkParts | undefined {
  const url = node.getChild("URL");
  if (url === null) return undefined;
  const marks = node.getChildren("LinkMark");
  const open = marks[0];
  const close = marks[1];
  if (open === undefined || close === undefined || close.from <= open.to) {
    return undefined;
  }
  return {
    href: slice(url.from, url.to),
    labelFrom: open.to,
    labelTo: close.from,
  };
}

// An image's resolved src and (plain-text) alt. Shared by the table-cell
// walker and live-preview's decorateImage. Undefined when there is no URL
// child, an empty src, or missing brackets — the caller leaves the raw
// `![…]` source in place. `![` and `]` are always the first two LinkMarks.
export type ImageParts = Readonly<{ src: string; alt: string }>;

export function imageParts(
  slice: SliceText,
  node: InlineNode,
): ImageParts | undefined {
  const url = node.getChild("URL");
  if (url === null) return undefined;
  const src = slice(url.from, url.to);
  if (src === "") return undefined;
  const marks = node.getChildren("LinkMark");
  const open = marks[0];
  const close = marks[1];
  if (open === undefined || close === undefined) return undefined;
  return { src, alt: slice(open.to, close.from) };
}

// The spans for one handled child node, or undefined for a node kind
// this walker doesn't model — its raw text then flows through unchanged
// (the safe default for entities, raw HTML, and future node types).
// Always a list, spliced in place of the node — most kinds yield one
// span; the bracket-literal link case yields several.
function spanFor(
  slice: SliceText,
  node: InlineNode,
): readonly InlineSpan[] | undefined {
  const container = CONTAINER_KIND[node.name];
  if (container !== undefined) {
    return [
      {
        kind: container,
        children: inlineSpans(slice, node, node.from, node.to),
      },
    ];
  }
  switch (node.name) {
    case "InlineCode": {
      const marks = node.getChildren("CodeMark");
      const open = marks[0];
      const close = marks[marks.length - 1];
      const text =
        open !== undefined && close !== undefined && close.from > open.to
          ? slice(open.to, close.from)
          : slice(node.from, node.to);
      return [{ kind: "code", text }];
    }
    case "Link": {
      // No destination (`[text]`): render literally, brackets included —
      // LinkMark is not skipped, so the recursion emits them as text while
      // still rendering any emphasis inside the label.
      if (node.getChild("URL") === null) {
        return inlineSpans(slice, node, node.from, node.to);
      }
      const parts = linkParts(slice, node);
      if (parts === undefined) {
        return [{ kind: "text", text: slice(node.from, node.to) }];
      }
      return [
        {
          kind: "link",
          href: parts.href,
          children: inlineSpans(slice, node, parts.labelFrom, parts.labelTo),
        },
      ];
    }
    case "Autolink": {
      const text = slice(node.from, node.to);
      const href = text.replace(/^<|>$/g, "");
      return [{ kind: "link", href, children: [{ kind: "text", text: href }] }];
    }
    case "URL":
      // GFM autolink literal: a bare URL directly in the text.
      return [
        {
          kind: "link",
          href: slice(node.from, node.to),
          children: [{ kind: "text", text: slice(node.from, node.to) }],
        },
      ];
    case "Image": {
      const parts = imageParts(slice, node);
      return parts === undefined
        ? undefined
        : [{ kind: "image", src: parts.src, alt: parts.alt }];
    }
    case "Escape":
      // `\|`, `\*`, … — render the escaped character alone.
      return [{ kind: "text", text: slice(node.from + 1, node.to) }];
    case "HardBreak":
      return [{ kind: "text", text: " " }];
    default:
      return undefined;
  }
}

// Walk `parent`'s children overlapping [from, to), emitting spans for the
// inline constructs the table widget renders and plain text for
// everything between and around them. Bounded by [from, to) so a link's
// label range can be walked without its URL/paren children leaking in.
export function inlineSpans(
  slice: SliceText,
  parent: InlineNode,
  from: number,
  to: number,
): readonly InlineSpan[] {
  const out: InlineSpan[] = [];
  let pos = from;
  const flushText = (upTo: number): void => {
    const end = Math.min(upTo, to);
    if (end > pos) {
      const text = slice(pos, end);
      if (text !== "") out.push({ kind: "text", text });
    }
    pos = Math.max(pos, end);
  };
  for (
    let child = parent.firstChild;
    child !== null;
    child = child.nextSibling
  ) {
    if (child.to <= from || child.from >= to) continue;
    if (SKIP_MARKS.has(child.name)) {
      flushText(child.from);
      pos = Math.max(pos, child.to);
      continue;
    }
    const spans = spanFor(slice, child);
    if (spans === undefined) continue; // unhandled: text flows through
    flushText(child.from);
    out.push(...spans);
    pos = Math.max(pos, child.to);
  }
  flushText(to);
  return out;
}

// Flattened plain text of a span list — the accessible text (title
// attributes, tests) for a rendered cell.
export function spanText(spans: readonly InlineSpan[]): string {
  return spans
    .map((s) => {
      switch (s.kind) {
        case "text":
        case "code":
          return s.text;
        case "image":
          return s.alt;
        default:
          return spanText(s.children);
      }
    })
    .join("");
}
