import type { List, RootContent } from "mdast";
import { toString as mdastToString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import type { BlockKind, NextBlock } from "./block-match";
import { parseFrontmatter } from "./frontmatter";

// Markdown → ordered block list, the input side of the anchor matcher.
//
// Pure and zero-IO: deterministic on its input, no clock, no storage. The
// canonical artifact stays the whole markdown blob; this is a read-time
// lens that derives the block decomposition used to maintain block ids.
//
// Granularity (per the collaboration design): list items and table rows
// are their OWN blocks, so a comment can anchor to a single bullet or row.
// Container nodes (`list`, `table`) emit nothing themselves — only their
// items/rows. Frontmatter is stripped first (it is metadata, not body
// content), reusing the same split the save path uses.
//
// remark/mdast is deliberate: it is the same parser family the web view
// renders with (`react-markdown` + `remark-gfm`), so the block model
// agrees with what a reader sees, and mdast node types map 1:1 onto
// `BlockKind`.

// Bump on ANY change that can alter parseBlocks' output for a given input
// (granularity rules here, or a remark/remark-gfm upgrade that shifts block
// boundaries). A persisted block map is tagged with the version that
// produced it; on mismatch the rebase cannot trust a positional re-parse
// and falls back to text-quote re-anchoring. Same version + same blob ⇒
// byte-identical re-parse ⇒ a safe zip of stored ids onto re-parsed text.
export const BLOCK_PARSER_VERSION = 1;

const processor = unified().use(remarkParse).use(remarkGfm).freeze();

// A parsed block plus its half-open source range [sourceStart, sourceEnd)
// in the ORIGINAL markdown (frontmatter offset already applied), so a
// caller can slice `markdown.slice(sourceStart, sourceEnd)` to recover the
// block's source — used to render a document block-by-block for commenting
// and to splice review suggestions back into the original markdown.
export type ParsedBlock = Readonly<{
  kind: BlockKind;
  text: string;
  sourceStart: number;
  sourceEnd: number;
}>;

export function parseBlocks(markdown: string): readonly NextBlock[] {
  return parseBlocksWithRanges(markdown).map((b) => ({
    kind: b.kind,
    text: b.text,
  }));
}

export function parseBlocksWithRanges(
  markdown: string,
): readonly ParsedBlock[] {
  const parsed = parseFrontmatter(markdown);
  const body = parsed.ok ? parsed.body : markdown;
  // `body` is a suffix of `markdown` (a leading frontmatter fence is the
  // only thing stripped), so mdast's body-relative offsets shift by this.
  const bodyOffset = markdown.length - body.length;
  const tree = processor.parse(body);
  const out: ParsedBlock[] = [];
  emitBlocks(tree.children, bodyOffset, out);
  return out;
}

// Structurally matches every mdast node (each carries `position?: Position`);
// the explicit `| undefined` aligns with mdast's optionals under
// exactOptionalPropertyTypes.
type Positioned = Readonly<{
  position?:
    | Readonly<{
        start: Readonly<{ offset?: number | undefined }>;
        end: Readonly<{ offset?: number | undefined }>;
      }>
    | undefined;
}>;

const rangeOf = (
  node: Positioned,
  bodyOffset: number,
): readonly [number, number] => [
  (node.position?.start.offset ?? 0) + bodyOffset,
  (node.position?.end.offset ?? 0) + bodyOffset,
];

function push(
  out: ParsedBlock[],
  kind: BlockKind,
  text: string,
  [sourceStart, sourceEnd]: readonly [number, number],
): void {
  out.push({ kind, text, sourceStart, sourceEnd });
}

function emitBlocks(
  nodes: readonly RootContent[],
  bodyOffset: number,
  out: ParsedBlock[],
): void {
  for (const node of nodes) {
    switch (node.type) {
      case "heading":
        push(out, "heading", mdastToString(node), rangeOf(node, bodyOffset));
        break;
      case "paragraph":
        push(out, "paragraph", mdastToString(node), rangeOf(node, bodyOffset));
        break;
      case "code":
        push(out, "code", node.value, rangeOf(node, bodyOffset));
        break;
      case "html":
        push(out, "html", node.value, rangeOf(node, bodyOffset));
        break;
      case "blockquote":
        // Coarse for v1: a whole quote is one block. Refine to per-paragraph
        // if multi-paragraph quotes become common anchor targets.
        push(out, "blockquote", mdastToString(node), rangeOf(node, bodyOffset));
        break;
      case "thematicBreak":
        push(out, "thematic-break", "", rangeOf(node, bodyOffset));
        break;
      case "list":
        emitListItems(node, bodyOffset, out);
        break;
      case "table":
        for (const row of node.children) {
          const cells = row.children.map((cell) => mdastToString(cell));
          push(out, "table-row", cells.join(" | "), rangeOf(row, bodyOffset));
        }
        break;
      // definition / footnoteDefinition / yaml carry no anchorable body
      // content (or are handled out of band as frontmatter) — skipped.
      default:
        break;
    }
  }
}

// A list item is its own block; nested lists recurse into their own items.
// The item's text + range cover its DIRECT content only (its paragraph), so
// a parent item and its sub-items never overlap.
function emitListItems(
  list: List,
  bodyOffset: number,
  out: ParsedBlock[],
): void {
  for (const item of list.children) {
    const ownText: string[] = [];
    let firstOwn: Positioned | undefined;
    let lastOwn: Positioned | undefined;
    const nested: List[] = [];
    for (const child of item.children) {
      if (child.type === "list") {
        nested.push(child);
      } else {
        ownText.push(mdastToString(child));
        firstOwn ??= child;
        lastOwn = child;
      }
    }
    const start =
      (item.position?.start.offset ?? firstOwn?.position?.start.offset ?? 0) +
      bodyOffset;
    const end =
      (lastOwn?.position?.end.offset ?? item.position?.end.offset ?? 0) +
      bodyOffset;
    push(out, "list-item", ownText.join("\n"), [start, end]);
    for (const sub of nested) emitListItems(sub, bodyOffset, out);
  }
}
