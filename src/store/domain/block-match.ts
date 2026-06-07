import type { BlockId } from "../../ids";

// Block-level structural matching across two document versions.
//
// Anchors (comments, suggestion hunks) attach to a block identity, not a
// character offset, so they survive edits and — critically — moves. The
// canonical document stays a flat markdown blob; block ids are derived,
// non-canonical side state recomputed at each save by matching the new
// block list against the previous one. This module is that matcher: pure,
// zero-IO, content-first.
//
// "Content-first" means identity follows what a block *says*, not where it
// sits: a block relocated within the document keeps its id because it is
// matched by content, not position. Position is only a tiebreak among
// equally-good candidates. That property is the whole reason a comment can
// follow a moved paragraph.

// The single source of truth for the block-kind vocabulary: the tuple
// drives the `BlockKind` union AND constrains what the persistence layer
// may store (the DO schema consumes BLOCK_KINDS, never the reverse — pure
// domain must not import the DB).
export const BLOCK_KINDS = [
  "paragraph",
  "heading",
  "list-item",
  "code",
  "table-row",
  "blockquote",
  "thematic-break",
  "html",
] as const;

export type BlockKind = (typeof BLOCK_KINDS)[number];

// A block already carrying an id — the previous version's block map.
export type Block = Readonly<{
  id: BlockId;
  kind: BlockKind;
  text: string;
}>;

// A freshly parsed block from the new version, not yet assigned an id.
export type NextBlock = Readonly<{
  kind: BlockKind;
  text: string;
}>;

// Where a matched block's id came from.
//   unchanged — exact content carry; intra-block offsets are stable.
//   modified  — similarity carry; text drifted, so any intra-block anchor
//               offset must be re-diffed locally against the new text.
//   inserted  — no predecessor; a fresh id was minted.
export type BlockOrigin = Readonly<
  | { status: "unchanged"; fromId: BlockId }
  | { status: "modified"; fromId: BlockId; similarity: number }
  | { status: "inserted" }
>;

export type MatchedBlock = Readonly<{
  id: BlockId;
  kind: BlockKind;
  text: string;
  origin: BlockOrigin;
}>;

export type MatchResult = Readonly<{
  // `next`, in document order, with an id assigned to every block.
  blocks: readonly MatchedBlock[];
  // Previous-version ids with no counterpart in `next`. Anchors pinned to
  // these have lost their block: the caller attempts text-quote recovery,
  // else marks them orphaned.
  deleted: readonly BlockId[];
}>;

// A `modified` carry requires at least this idf-weighted overlap. Below
// it, a changed block is treated as delete + insert rather than a false
// carry (a fully rewritten paragraph *should* orphan its comments).
//
// The similarity is token-set Jaccard weighted by inverse document
// frequency over *this document's* blocks: tokens common across many
// blocks (function words, but also domain boilerplate) carry little
// weight; tokens distinctive to a block decide identity. That adapts per
// document with no maintained stopword list, and is what stops two
// unrelated paragraphs that merely share common words from being
// conflated. The exact-match tier — every move, reorder, and duplicate —
// does NOT depend on this constant; only the fuzzy "edited block" tier.
const MODIFIED_SIMILARITY_THRESHOLD = 0.5;

export function matchBlocks(
  input: Readonly<{
    prev: readonly Block[];
    next: readonly NextBlock[];
    mintId: () => BlockId;
  }>,
): MatchResult {
  const { prev, next, mintId } = input;

  const assigned = new Array<BlockOrigin | undefined>(next.length).fill(
    undefined,
  );
  const takenPrev = new Set<number>();

  // Tier 1 — exact content match, content-first. Group prev indices by
  // signature; pair the i-th prev occurrence of a signature with the i-th
  // next occurrence, in document order. Unique content matches regardless
  // of position (this is move-following); identical duplicates pair by
  // order of appearance.
  const prevBySignature = new Map<string, number[]>();
  prev.forEach((block, i) => {
    const sig = signature(block);
    const queue = prevBySignature.get(sig);
    if (queue === undefined) prevBySignature.set(sig, [i]);
    else queue.push(i);
  });
  next.forEach((block, j) => {
    const queue = prevBySignature.get(signature(block));
    const i = queue?.shift();
    if (i === undefined) return;
    const matched = prev[i];
    if (matched === undefined) return;
    takenPrev.add(i);
    assigned[j] = { status: "unchanged", fromId: matched.id };
  });

  // Tier 2 — similarity match for the remainder. Score every cross pair of
  // same-kind, still-unmatched blocks; greedily take the highest-scoring
  // non-conflicting pairs. Position enters only as a tiebreak, so a block
  // that was both moved and edited can still match. Token weights are idf
  // over the whole document, so common vocabulary cannot manufacture a
  // match.
  const idf = computeIdf(prev, next);
  const candidates: Readonly<{
    prevIndex: number;
    nextIndex: number;
    score: number;
  }>[] = [];
  prev.forEach((p, i) => {
    if (takenPrev.has(i)) return;
    next.forEach((n, j) => {
      if (assigned[j] !== undefined) return;
      if (p.kind !== n.kind) return;
      const score = tokenSimilarity(p.text, n.text, idf);
      if (score >= MODIFIED_SIMILARITY_THRESHOLD) {
        candidates.push({ prevIndex: i, nextIndex: j, score });
      }
    });
  });
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      Math.abs(a.prevIndex - a.nextIndex) -
        Math.abs(b.prevIndex - b.nextIndex) ||
      a.prevIndex - b.prevIndex ||
      a.nextIndex - b.nextIndex,
  );
  for (const c of candidates) {
    if (takenPrev.has(c.prevIndex) || assigned[c.nextIndex] !== undefined) {
      continue;
    }
    const matched = prev[c.prevIndex];
    if (matched === undefined) continue;
    takenPrev.add(c.prevIndex);
    assigned[c.nextIndex] = {
      status: "modified",
      fromId: matched.id,
      similarity: c.score,
    };
  }

  // Tier 3 — leftovers. Unassigned next blocks are new (mint an id, in
  // document order so minting is deterministic); unmatched prev blocks are
  // deleted.
  const blocks: MatchedBlock[] = next.map((block, j) => {
    const origin = assigned[j] ?? ({ status: "inserted" } as const);
    return {
      id: origin.status === "inserted" ? mintId() : origin.fromId,
      kind: block.kind,
      text: block.text,
      origin,
    };
  });
  const deleted: BlockId[] = [];
  prev.forEach((block, i) => {
    if (!takenPrev.has(i)) deleted.push(block.id);
  });

  return { blocks, deleted };
}

// Exact-identity key: same kind AND same whitespace-normalized text.
export function signature(
  block: Readonly<{ kind: BlockKind; text: string }>,
): string {
  return `${block.kind}\u0000${normalize(block.text)}`;
}

// Token-set Jaccard overlap in [0, 1], optionally weighted by an idf map
// (token → weight); unknown tokens and the unweighted call default to
// weight 1, recovering plain Jaccard. Two empty blocks are identical (1);
// one empty and one not share nothing (0).
export function tokenSimilarity(
  a: string,
  b: string,
  idf?: ReadonlyMap<string, number>,
): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  const weight = (t: string): number => idf?.get(t) ?? 1;
  let intersection = 0;
  let union = 0;
  for (const t of ta) {
    union += weight(t);
    if (tb.has(t)) intersection += weight(t);
  }
  for (const t of tb) if (!ta.has(t)) union += weight(t);
  return union === 0 ? 0 : intersection / union;
}

// Smoothed inverse document frequency over the blocks being matched (prev
// ∪ next as the "document"). A token in every block weighs ~1; a token
// unique to one block weighs more. Smoothing keeps every weight positive
// so an all-common-vocabulary pair still has a defined similarity.
export function computeIdf(
  prev: readonly Block[],
  next: readonly NextBlock[],
): ReadonlyMap<string, number> {
  const documentFrequency = new Map<string, number>();
  for (const block of [...prev, ...next]) {
    for (const t of tokens(block.text)) {
      documentFrequency.set(t, (documentFrequency.get(t) ?? 0) + 1);
    }
  }
  const total = prev.length + next.length;
  const idf = new Map<string, number>();
  for (const [t, df] of documentFrequency) {
    idf.set(t, Math.log((total + 1) / (df + 1)) + 1);
  }
  return idf;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function tokens(text: string): ReadonlySet<string> {
  return new Set(
    normalize(text.toLowerCase())
      .split(" ")
      .filter((t) => t.length > 0),
  );
}
