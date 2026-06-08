import type { CommentThreadView } from "@/lib/server/comments";
import type {
  SuggestionHunkView,
  SuggestionView,
} from "@/lib/server/suggestions";
import type { AnchorBlock, HighlightAnchor } from "@/lib/text-anchor";

export type ReviewItem = CommentReviewItem | SuggestionReviewItem;

export type CommentReviewItem = Readonly<{
  id: `comment:${number}`;
  kind: "comment";
  sortStart: number;
  active: boolean;
  anchorEvidence: CommentAnchorEvidence;
  thread: CommentThreadView;
}>;

export type CommentAnchorEvidence = Readonly<
  | { status: "present"; original: string }
  | { status: "changed"; original: string; current: string }
  | { status: "removed"; original: string }
>;

export type SuggestionReviewItem = Readonly<{
  id: `suggestion:${number}`;
  kind: "suggestion";
  sortStart: number;
  active: boolean;
  applicable: boolean;
  suggestion: SuggestionView;
}>;

export type InlineSuggestionMark = Readonly<{
  id: `suggestion:${number}:hunk:${number}`;
  suggestionId: number;
  hunkId: number;
  op: SuggestionHunkView["op"];
  anchor: HighlightAnchor;
}>;

export type ReviewModel = Readonly<{
  items: readonly ReviewItem[];
  inlineSuggestionMarks: readonly InlineSuggestionMark[];
  activeCount: number;
  activeCommentCount: number;
  activeSuggestionCount: number;
  staleSuggestionCount: number;
}>;

const MAX_INLINE_SUGGESTION_MARKS = 80;

type Input = Readonly<{
  blocks: readonly AnchorBlock[];
  threads: readonly CommentThreadView[];
  suggestions: readonly SuggestionView[];
  docVersion: number;
}>;

const itemSort = (a: ReviewItem, b: ReviewItem): number =>
  a.sortStart - b.sortStart || a.id.localeCompare(b.id);

export function buildReviewModel(input: Input): ReviewModel {
  const byBlockId = new Map<string, AnchorBlock>();
  for (const block of input.blocks) {
    if (block.id !== undefined) byBlockId.set(block.id, block);
  }

  const commentItems: CommentReviewItem[] = input.threads.map((thread) => ({
    id: `comment:${thread.id}`,
    kind: "comment",
    sortStart: commentSortStart(thread, byBlockId),
    active: thread.status === "open",
    anchorEvidence: commentAnchorEvidence(thread, input.blocks, byBlockId),
    thread,
  }));

  const suggestionItems: SuggestionReviewItem[] = input.suggestions.map(
    (suggestion) => {
      const applicable = isCurrentSuggestion(suggestion, input.docVersion);
      return {
        id: `suggestion:${suggestion.id}`,
        kind: "suggestion",
        sortStart: suggestionSortStart(suggestion),
        active: isOpenSuggestion(suggestion) && applicable,
        applicable,
        suggestion,
      };
    },
  );

  const inlineSuggestionMarks = input.suggestions
    .filter((s) => isOpenCurrentSuggestion(s, input.docVersion))
    .flatMap((s) => suggestionMarks(s, input.blocks))
    .slice(0, MAX_INLINE_SUGGESTION_MARKS);

  const activeCommentCount = commentItems.filter((i) => i.active).length;
  const activeSuggestionCount = suggestionItems.filter((i) => i.active).length;
  const staleSuggestionCount = suggestionItems.filter(
    (i) => isOpenSuggestion(i.suggestion) && !i.applicable,
  ).length;

  return {
    items: [...commentItems, ...suggestionItems].sort(itemSort),
    inlineSuggestionMarks,
    activeCount: activeCommentCount + activeSuggestionCount,
    activeCommentCount,
    activeSuggestionCount,
    staleSuggestionCount,
  };
}

function isOpenSuggestion(suggestion: SuggestionView): boolean {
  return suggestion.status === "open";
}

function isCurrentSuggestion(
  suggestion: SuggestionView,
  docVersion: number,
): boolean {
  return suggestion.baseDocVersion === docVersion;
}

function isOpenCurrentSuggestion(
  suggestion: SuggestionView,
  docVersion: number,
): boolean {
  return (
    isOpenSuggestion(suggestion) && isCurrentSuggestion(suggestion, docVersion)
  );
}

function commentSortStart(
  thread: CommentThreadView,
  byBlockId: ReadonlyMap<string, AnchorBlock>,
): number {
  const block = byBlockId.get(thread.anchorBlockId);
  return block === undefined
    ? Number.MAX_SAFE_INTEGER
    : block.sourceStart + thread.anchorStart;
}

function suggestionSortStart(suggestion: SuggestionView): number {
  return suggestion.hunks.reduce(
    (min, hunk) => Math.min(min, hunk.baseStart),
    Number.MAX_SAFE_INTEGER,
  );
}

function commentAnchorEvidence(
  thread: CommentThreadView,
  blocks: readonly AnchorBlock[],
  byBlockId: ReadonlyMap<string, AnchorBlock>,
): CommentAnchorEvidence {
  const original = quoteExcerpt(thread.quote);
  const block = byBlockId.get(thread.anchorBlockId);
  const currentAtAnchor =
    block === undefined ? undefined : anchoredExcerpt(thread, block);

  if (currentAtAnchor === undefined) {
    const moved = findQuoteExcerpt(thread.quote.exact, blocks);
    return moved === undefined
      ? { status: "removed", original }
      : { status: "changed", original, current: moved };
  }

  if (currentAtAnchor.exact === thread.quote.exact) {
    return { status: "present", original };
  }
  return {
    status: "changed",
    original,
    current: currentAtAnchor.excerpt,
  };
}

function quoteExcerpt(quote: CommentThreadView["quote"]): string {
  return quote.prefix + quote.exact + quote.suffix;
}

function anchoredExcerpt(
  thread: CommentThreadView,
  block: AnchorBlock,
): Readonly<{ exact: string; excerpt: string }> | undefined {
  if (
    thread.anchorEnd <= thread.anchorStart ||
    thread.anchorStart < 0 ||
    thread.anchorEnd > block.text.length
  ) {
    return undefined;
  }
  return {
    exact: block.text.slice(thread.anchorStart, thread.anchorEnd),
    excerpt: blockExcerpt(block.text, thread.anchorStart, thread.anchorEnd),
  };
}

function findQuoteExcerpt(
  exact: string,
  blocks: readonly AnchorBlock[],
): string | undefined {
  if (exact === "") return undefined;
  for (const block of blocks) {
    const at = block.text.indexOf(exact);
    if (at !== -1) return blockExcerpt(block.text, at, at + exact.length);
  }
  return undefined;
}

function blockExcerpt(text: string, start: number, end: number): string {
  const before = text.slice(Math.max(0, start - 48), start);
  const selected = text.slice(start, end);
  const after = text.slice(end, Math.min(text.length, end + 48));
  return before + selected + after;
}

function suggestionMarks(
  suggestion: SuggestionView,
  blocks: readonly AnchorBlock[],
): readonly InlineSuggestionMark[] {
  return suggestion.hunks.flatMap((hunk) => {
    const anchors =
      hunk.op === "insert"
        ? insertionAnchors(hunk, blocks)
        : rangeAnchors(hunk, blocks);
    return anchors.map((anchor) => ({
      id: `suggestion:${suggestion.id}:hunk:${hunk.id}` as const,
      suggestionId: suggestion.id,
      hunkId: hunk.id,
      op: hunk.op,
      anchor,
    }));
  });
}

function rangeAnchors(
  hunk: SuggestionHunkView,
  blocks: readonly AnchorBlock[],
): readonly HighlightAnchor[] {
  if (hunk.baseEnd <= hunk.baseStart) return [];
  return blocks.flatMap((block) => {
    if (
      block.id === undefined ||
      block.text.length === 0 ||
      !hunkFullyCoversBlock(hunk, block)
    ) {
      return [];
    }
    return [
      {
        blockId: block.id,
        start: 0,
        end: block.text.length,
        quote: { prefix: "", exact: block.text, suffix: "" },
      },
    ];
  });
}

function hunkFullyCoversBlock(
  hunk: SuggestionHunkView,
  block: AnchorBlock,
): boolean {
  return hunk.baseStart <= block.sourceStart && hunk.baseEnd >= block.sourceEnd;
}

function insertionAnchors(
  hunk: SuggestionHunkView,
  blocks: readonly AnchorBlock[],
): readonly HighlightAnchor[] {
  const before = [...blocks]
    .reverse()
    .find(
      (b) =>
        b.id !== undefined &&
        b.text.length > 0 &&
        b.sourceEnd <= hunk.baseStart,
    );
  const after = blocks.find(
    (b) =>
      b.id !== undefined &&
      b.text.length > 0 &&
      b.sourceStart >= hunk.baseStart,
  );
  const block = before ?? after;
  if (block?.id === undefined || block.text.length === 0) return [];
  const atEnd = before !== undefined;
  const start = atEnd ? block.text.length - 1 : 0;
  const end = atEnd ? block.text.length : 1;
  return [
    {
      blockId: block.id,
      start,
      end,
      quote: {
        prefix: "",
        exact: block.text.slice(start, end),
        suffix: "",
      },
    },
  ];
}
