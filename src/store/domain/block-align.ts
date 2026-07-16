import {
  computeIdf,
  MODIFIED_SIMILARITY_THRESHOLD,
  type NextBlock,
  signature,
  tokenSimilarity,
} from "./block-match";

// Order-preserving block alignment for the suggestion diff.
//
// The anchor matcher (`matchBlocks`) is content-first: identity follows
// what a block *says* wherever it moves — exactly right for comments,
// exactly wrong for a diff. There a relocated block matching "unchanged"
// leaves the move invisible (no hunk represents it), so no granular hunk
// set can reconstruct the base and the diff degrades to one
// whole-document hunk. This module is the diff's own lens: alignment
// never reorders, so a moved block becomes an explicit delete + insert
// pair — granular, faithful, reviewable; exactly what git shows.
//
// Three passes:
//   1. Patience anchoring: signatures unique in BOTH sequences, kept in
//      order via longest-increasing-subsequence — O((n+m) log) and, in
//      prose (where almost every block is unique), it pins nearly the
//      whole skeleton no matter how large the document is or how far
//      apart the edits sit.
//   2. LCS over exact block signatures inside each gap between patience
//      anchors — catches repeated non-unique blocks (`---` breaks,
//      duplicate bullets). Byte comparison stays the caller's job: a
//      signature match is NOT proof the bytes matched.
//   3. Between consecutive anchors, pair the same-kind leftovers that
//      face each other as replaces when their idf-weighted token
//      similarity clears the anchor matcher's threshold, so an in-place
//      edit classifies as ONE replace hunk exactly as it did before.
//
// Pure, zero-IO. The gap DPs are O(n·m) over GAP sizes, which patience
// keeps small for real documents; a pathological gap that would exceed
// MAX_DP_CELLS is skipped (its blocks fall out as delete + insert) and
// byte fidelity is left to the diff's self-verification.

// For each proposed block index: the base block index shown at that
// position, or undefined for an insertion. Defined values are strictly
// increasing (order-preserving); base indices absent from the image are
// deletions.
export type BlockAlignment = readonly (number | undefined)[];

// Empirically calibrated (2026-07-16): the gap DPs cost ~1.2µs/cell on
// dev hardware, so 160k cells (a 400×400-block gap between patience
// anchors) bounds any single DP at ~200ms — and real gaps are tiny, so
// the practical cost is milliseconds. The previous 4M ceiling admitted
// ~5s pathological diffs on a serialized DO. Beyond the ceiling a gap is
// left unpaired (delete + insert) and self-verification decides.
const MAX_DP_CELLS = 160_000;

export function alignBlocks(
  input: Readonly<{
    base: readonly NextBlock[];
    proposed: readonly NextBlock[];
  }>,
): BlockAlignment {
  const { base, proposed } = input;
  const baseSigs = base.map(signature);
  const propSigs = proposed.map(signature);
  const aligned = new Array<number | undefined>(proposed.length).fill(
    undefined,
  );

  // Greedy common prefix/suffix (always LCS-optimal) so the DP only sees
  // the changed middle.
  let lo = 0;
  while (
    lo < base.length &&
    lo < proposed.length &&
    baseSigs[lo] === propSigs[lo]
  ) {
    aligned[lo] = lo;
    lo += 1;
  }
  let baseHi = base.length;
  let propHi = proposed.length;
  while (
    baseHi > lo &&
    propHi > lo &&
    baseSigs[baseHi - 1] === propSigs[propHi - 1]
  ) {
    baseHi -= 1;
    propHi -= 1;
    aligned[propHi] = baseHi;
  }

  // Patience skeleton over the trimmed middle, then exact-match LCS
  // inside each gap between consecutive patience anchors (the final
  // iteration, against the trim boundary, covers the tail gap).
  const anchors = patienceAnchors({ baseSigs, propSigs, lo, baseHi, propHi });
  let gapBaseLo = lo;
  let gapPropLo = lo;
  const gaps: (readonly [number, number])[] = [
    ...anchors,
    [baseHi, propHi] as const,
  ];
  for (const [gapIndex, [bi, pj]] of gaps.entries()) {
    for (const [i, j] of lcsAnchors({
      baseSigs,
      propSigs,
      baseLo: gapBaseLo,
      baseHi: bi,
      propLo: gapPropLo,
      propHi: pj,
    })) {
      aligned[j] = i;
    }
    if (gapIndex < anchors.length) aligned[pj] = bi; // a real anchor, not the boundary
    gapBaseLo = bi + 1;
    gapPropLo = pj + 1;
  }

  pairFacingLeftovers({ base, proposed, aligned });
  return aligned;
}

// Signatures occurring exactly once in BOTH untrimmed middles, kept when
// they appear in the same relative order (longest increasing subsequence
// of base indices over proposed order). In prose nearly every block is
// unique, so this pins the skeleton in O((n+m) log) regardless of how far
// apart the edits sit — the trick patience diff is named for.
function patienceAnchors(
  input: Readonly<{
    baseSigs: readonly string[];
    propSigs: readonly string[];
    lo: number;
    baseHi: number;
    propHi: number;
  }>,
): readonly (readonly [number, number])[] {
  const { baseSigs, propSigs, lo, baseHi, propHi } = input;
  const seen = new Map<
    string,
    {
      baseCount: number;
      baseIndex: number;
      propCount: number;
      propIndex: number;
    }
  >();
  for (let i = lo; i < baseHi; i += 1) {
    const sig = baseSigs[i] ?? "";
    const e = seen.get(sig) ?? {
      baseCount: 0,
      baseIndex: 0,
      propCount: 0,
      propIndex: 0,
    };
    e.baseCount += 1;
    e.baseIndex = i;
    seen.set(sig, e);
  }
  for (let j = lo; j < propHi; j += 1) {
    const e = seen.get(propSigs[j] ?? "");
    if (e === undefined) continue;
    e.propCount += 1;
    e.propIndex = j;
  }
  const candidates = [...seen.values()]
    .filter((e) => e.baseCount === 1 && e.propCount === 1)
    .sort((a, b) => a.propIndex - b.propIndex);

  // Longest STRICTLY increasing subsequence of baseIndex over proposed
  // order — patience sorting with binary search, O(k log k).
  const tailIndexes: number[] = []; // candidate index holding each pile's tail
  const predecessor = new Array<number>(candidates.length).fill(-1);
  candidates.forEach((c, k) => {
    let low = 0;
    let high = tailIndexes.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      const tail = candidates[tailIndexes[mid] ?? 0];
      if ((tail?.baseIndex ?? 0) < c.baseIndex) low = mid + 1;
      else high = mid;
    }
    predecessor[k] = low > 0 ? (tailIndexes[low - 1] ?? -1) : -1;
    tailIndexes[low] = k;
  });
  const chain: (readonly [number, number])[] = [];
  let at =
    tailIndexes.length > 0 ? (tailIndexes[tailIndexes.length - 1] ?? -1) : -1;
  while (at >= 0) {
    const c = candidates[at];
    if (c !== undefined) chain.push([c.baseIndex, c.propIndex]);
    at = predecessor[at] ?? -1;
  }
  return chain.reverse();
}

// Longest common subsequence of exact signatures over one gap, as
// strictly-increasing (base, proposed) index pairs. On a tie the walk
// prefers consuming a base block — deletes surface before inserts, the
// conventional diff shape.
function lcsAnchors(
  input: Readonly<{
    baseSigs: readonly string[];
    propSigs: readonly string[];
    baseLo: number;
    baseHi: number;
    propLo: number;
    propHi: number;
  }>,
): readonly (readonly [number, number])[] {
  const { baseSigs, propSigs, baseLo, baseHi, propLo, propHi } = input;
  const n = baseHi - baseLo;
  const m = propHi - propLo;
  if (n <= 0 || m <= 0 || n * m > MAX_DP_CELLS) return [];
  // Flattened (n+1)×(m+1) table; dp[x][y] = LCS length of
  // baseSigs[baseLo+x..baseHi) vs propSigs[propLo+y..propHi).
  // Suffix-indexed so the pair walk runs forward through both sequences.
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let x = n - 1; x >= 0; x -= 1) {
    for (let y = m - 1; y >= 0; y -= 1) {
      dp[x * width + y] =
        baseSigs[baseLo + x] === propSigs[propLo + y]
          ? (dp[(x + 1) * width + y + 1] ?? 0) + 1
          : Math.max(dp[(x + 1) * width + y] ?? 0, dp[x * width + y + 1] ?? 0);
    }
  }
  const pairs: (readonly [number, number])[] = [];
  let x = 0;
  let y = 0;
  while (x < n && y < m) {
    if (baseSigs[baseLo + x] === propSigs[propLo + y]) {
      pairs.push([baseLo + x, propLo + y]);
      x += 1;
      y += 1;
    } else if ((dp[(x + 1) * width + y] ?? 0) >= (dp[x * width + y + 1] ?? 0)) {
      x += 1;
    } else {
      y += 1;
    }
  }
  return pairs;
}

// Pass 2: between consecutive anchors, the unmatched base and proposed
// blocks face each other. Pair them (order-preserving, same kind,
// similarity at or above the anchor matcher's threshold) so an in-place
// edit stays ONE replace hunk; whatever stays unpaired falls out as
// delete + insert.
function pairFacingLeftovers(
  input: Readonly<{
    base: readonly NextBlock[];
    proposed: readonly NextBlock[];
    aligned: (number | undefined)[];
  }>,
): void {
  const { base, proposed, aligned } = input;
  const idf = computeIdf(base, proposed);
  let prevBase = -1;
  let j = 0;
  while (j < proposed.length) {
    const anchor = aligned[j];
    if (anchor !== undefined) {
      prevBase = anchor;
      j += 1;
      continue;
    }
    let jEnd = j;
    let nextBase = base.length;
    while (jEnd < proposed.length) {
      const a = aligned[jEnd];
      if (a !== undefined) {
        nextBase = a;
        break;
      }
      jEnd += 1;
    }
    // Base indices strictly between the surrounding anchors are exactly
    // the unmatched ones (pass-1 pairs are strictly increasing).
    for (const [bi, pj] of bestFacingPairs({
      base,
      proposed,
      idf,
      baseStart: prevBase + 1,
      baseEnd: nextBase,
      propStart: j,
      propEnd: jEnd,
    })) {
      aligned[pj] = bi;
    }
    j = jEnd;
  }
}

// Maximum-total-similarity order-preserving pairing between two runs of
// leftovers; only same-kind pairs at or above the threshold are
// eligible. When pairing and skipping tie, the walk prefers the pair
// (one replace hunk beats a delete + insert of the same bytes).
function bestFacingPairs(
  input: Readonly<{
    base: readonly NextBlock[];
    proposed: readonly NextBlock[];
    idf: ReadonlyMap<string, number>;
    baseStart: number;
    baseEnd: number;
    propStart: number;
    propEnd: number;
  }>,
): readonly (readonly [number, number])[] {
  const { base, proposed, idf, baseStart, baseEnd, propStart, propEnd } = input;
  const n = baseEnd - baseStart;
  const m = propEnd - propStart;
  if (n <= 0 || m <= 0 || n * m > MAX_DP_CELLS) return [];
  const score = (x: number, y: number): number => {
    const b = base[baseStart + x];
    const p = proposed[propStart + y];
    if (b === undefined || p === undefined) return -1;
    if (b.kind !== p.kind) return -1;
    const s = tokenSimilarity(b.text, p.text, idf);
    return s >= MODIFIED_SIMILARITY_THRESHOLD ? s : -1;
  };
  const width = m + 1;
  const dp = new Float64Array((n + 1) * width);
  const sims = new Float64Array(n * m);
  for (let x = n - 1; x >= 0; x -= 1) {
    for (let y = m - 1; y >= 0; y -= 1) {
      const s = (sims[x * m + y] = score(x, y));
      let best = Math.max(
        dp[(x + 1) * width + y] ?? 0,
        dp[x * width + y + 1] ?? 0,
      );
      if (s >= 0) best = Math.max(best, s + (dp[(x + 1) * width + y + 1] ?? 0));
      dp[x * width + y] = best;
    }
  }
  const pairs: (readonly [number, number])[] = [];
  let x = 0;
  let y = 0;
  while (x < n && y < m) {
    const s = sims[x * m + y] ?? -1;
    if (
      s >= 0 &&
      (dp[x * width + y] ?? 0) === s + (dp[(x + 1) * width + y + 1] ?? 0)
    ) {
      pairs.push([baseStart + x, propStart + y]);
      x += 1;
      y += 1;
    } else if ((dp[(x + 1) * width + y] ?? 0) >= (dp[x * width + y + 1] ?? 0)) {
      x += 1;
    } else {
      y += 1;
    }
  }
  return pairs;
}
