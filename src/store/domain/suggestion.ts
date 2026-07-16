import { alignBlocks } from "./block-align";
import { parseBlocksWithRanges } from "./block-parse";
import { frontmatterLength } from "./frontmatter";

// Suggestions as block-level hunks. A suggestion is a proposed alternative
// markdown for a document; `diffToHunks` turns base+proposed into an ordered
// list of block edits (each carrying a source range in the BASE and the
// mirror range in the PROPOSED), and `applyHunks` produces the post-review
// document by walking the PROPOSED bytes and reverting each REJECTED hunk
// back to base bytes. Pure, zero-IO.
//
// Byte fidelity is the contract: the diff aligns the two block sequences
// ORDER-PRESERVING (block-align.ts) — unlike the content-first anchor
// matcher, a relocated block is an explicit delete + insert pair, exactly
// what git shows — and compares SOURCE BYTES within each aligned pair, so
// a formatting-only edit (`**bold**` → `*bold*`) still yields a hunk.
// Mixed-decision spacing is PROPOSED-authoritative: the bytes between
// surviving blocks are whatever the proposer wrote (a tight list stays
// tight), never re-synthesized from the base. diffToHunks verifies per
// instance that full rejection reconstructs the base and degrades to a
// whole-document hunk when it cannot — see its contract comment below.
//
// The hunk vocabulary stays replace / insert / delete: a move is not a
// first-class op — it surfaces as its delete + insert pair, and a partial
// decision over the pair does the predictable thing (accept only the
// insert ⇒ the block is duplicated; accept only the delete ⇒ it is
// dropped).

// Create-proposals reuse the suggestion table with this base version as the
// discriminant: a real document's head is never below 1 (see nextVersion), so
// 0 can only mean "this document does not exist yet". A create-proposal
// carries no hunks — the whole body is the proposal.
export const CREATE_PROPOSAL_BASE_VERSION = 0;

export type ProposalStatus = "open" | "applied" | "rejected" | "stale";
export type ProposalOutcome = ProposalStatus | "partially_applied";

// Reviewers persist only the four storage statuses. Partial application is
// derived from the terminal hunk decisions so it cannot drift from what was
// actually applied or require a fifth stored status.
export function computeProposalOutcome(
  status: ProposalStatus,
  hunks: readonly Readonly<{
    decision: "pending" | "accepted" | "rejected";
  }>[],
): ProposalOutcome {
  if (status !== "applied" || hunks.length === 0) return status;
  const accepted = hunks.filter((hunk) => hunk.decision === "accepted").length;
  return accepted < hunks.length ? "partially_applied" : status;
}

export function isCreateProposal(
  row: Readonly<{ baseDocVersion: number }>,
): boolean {
  return row.baseDocVersion === CREATE_PROPOSAL_BASE_VERSION;
}

// Single source for the hunk-op vocabulary (the DO schema consumes this
// tuple for its enum column + CHECK, the same way it consumes BLOCK_KINDS).
export const HUNK_OPS = ["replace", "insert", "delete"] as const;
export type HunkOp = (typeof HUNK_OPS)[number];

// CANONICAL doc for hunk semantics — the db column and hydration comments
// point here.
export type Hunk = Readonly<{
  // Position in the proposed document order (also the apply tiebreak).
  ordinal: number;
  op: HunkOp;
  // Half-open base source range. Zero-width at the seam for `insert`, and
  // for the synthesized frontmatter-region `replace` when the base has no
  // fence (a frontmatter prepend).
  baseStart: number;
  baseEnd: number;
  // Half-open range into the PROPOSED document (the suggestion's stored
  // proposedMarkdown). The mirror of baseStart/baseEnd: ranges into two
  // immutable blobs cannot lie, unlike copied strings — separators are
  // derived by slicing the proposed bytes around these ranges. Zero-width
  // at the junction point for `delete` (where the surviving neighbors meet
  // in the proposed source), and for the frontmatter-region `replace` when
  // the proposal strips the fence entirely.
  propStart: number;
  propEnd: number;
  // New source for replace / insert; empty for delete. Always equals
  // `proposed.slice(propStart, propEnd)` — stored so hydration for the
  // review UI needs no re-slice.
  proposedText: string;
}>;

// The one whole-document hunk: the degenerate (but always-faithful) diff.
const wholeDocumentHunk = (base: string, proposed: string): Hunk => ({
  ordinal: 1,
  op: "replace",
  baseStart: 0,
  baseEnd: base.length,
  propStart: 0,
  propEnd: proposed.length,
  proposedText: proposed,
});

// How the diff represents the change: `block` — granular per-block hunks
// the reviewer decides individually; `whole-document` — the verification
// below failed and the diff degraded to ONE all-or-nothing hunk. Recorded
// at create time (a column on the suggestion row) so degradation frequency
// is observable.
export const SUGGESTION_GRANULARITIES = ["block", "whole-document"] as const;
export type SuggestionGranularity = (typeof SUGGESTION_GRANULARITIES)[number];

export type SuggestionDiff = Readonly<{
  hunks: readonly Hunk[];
  granularity: SuggestionGranularity;
}>;

// Contract, enforced for EVERY input pair:
//   diffToHunks(base, proposed) === []                ⟺  base === proposed
//   applyHunks({base, proposed, rejected: []})        === proposed (all
//     accepted — holds by construction: zero reverts emit the proposal)
//   applyHunks({base, proposed, rejected: allHunks})  === base (all
//     rejected — verified right here by actually reverting)
//
// Granular block hunks are OFFERED only when full rejection reconstructs
// the base byte-for-byte — the direction that is NOT automatic under the
// rejected-revert formulation. When the block lens cannot represent the
// change faithfully (an edited link-reference definition, spacing shifts
// around unchanged blocks), the
// diff degrades to ONE whole-document hunk: the review loses per-block
// granularity but can never silently drop or distort part of what the
// proposer wrote. Correctness beats granularity.
export function diffSuggestion(base: string, proposed: string): SuggestionDiff {
  if (base === proposed) return { hunks: [], granularity: "block" };
  const hunks = blockHunks(base, proposed);
  // Note a zero-hunk block diff (a change entirely invisible to the block
  // lens) fails here too: reverting nothing returns the proposal.
  if (applyHunks({ base, proposed, rejected: hunks }) === base) {
    return { hunks, granularity: "block" };
  }
  return {
    hunks: [wholeDocumentHunk(base, proposed)],
    granularity: "whole-document",
  };
}

export function diffToHunks(base: string, proposed: string): readonly Hunk[] {
  return diffSuggestion(base, proposed).hunks;
}

function blockHunks(base: string, proposed: string): readonly Hunk[] {
  const baseBlocks = parseBlocksWithRanges(base);
  const proposedBlocks = parseBlocksWithRanges(proposed);
  // Order-preserving alignment: aligned[j] is the base block shown at
  // proposed position j (byte-compared below), undefined for an inserted
  // block; base indices absent from the image are deletes. Never
  // move-following — that lens belongs to comment anchors, not diffs.
  const aligned = alignBlocks({ base: baseBlocks, proposed: proposedBlocks });

  const hunks: Hunk[] = [];
  // Where each carried base block landed in the proposed order — membership
  // marks the block as kept/edited (vs deleted), and the junction-point
  // lookup for deletes needs the proposed-side neighbors.
  const carriedToProposed = new Map<number, number>();
  let ordinal = 0;

  // Frontmatter is invisible to the block lens (block-parse strips it), so
  // diff the region byte-for-byte as its own hunk — otherwise a proposal's
  // frontmatter edit would silently vanish on apply. Zero-width base range
  // when the base has no fence (a prepend); the slice carries its own
  // trailing separator.
  const baseFmEnd = frontmatterLength(base);
  const propFmEnd = frontmatterLength(proposed);
  if (base.slice(0, baseFmEnd) !== proposed.slice(0, propFmEnd)) {
    hunks.push({
      ordinal: (ordinal += 1),
      op: "replace",
      baseStart: 0,
      baseEnd: baseFmEnd,
      propStart: 0,
      propEnd: propFmEnd,
      proposedText: proposed.slice(0, propFmEnd),
    });
  }

  // The base offset a new (inserted) block is anchored after: the end of
  // the most recent kept/edited base block, or the end of the frontmatter
  // region at document start.
  let seam = baseFmEnd;

  proposedBlocks.forEach((pb, j) => {
    const proposedText = proposed.slice(pb.sourceStart, pb.sourceEnd);
    const i = aligned[j];
    if (i !== undefined) {
      const bb = baseBlocks[i];
      if (bb === undefined) return;
      carriedToProposed.set(i, j);
      // Alignment pairs blocks by whitespace-normalized PLAIN text (the
      // exact tier) or token similarity (the replace tier) — not proof
      // the bytes matched. A formatting-only edit (`**bold**` → `*bold*`,
      // a reflowed soft wrap) must still be a reviewable hunk, so compare
      // the source slices.
      const baseText = base.slice(bb.sourceStart, bb.sourceEnd);
      if (baseText !== proposedText) {
        hunks.push({
          ordinal: (ordinal += 1),
          op: "replace",
          baseStart: bb.sourceStart,
          baseEnd: bb.sourceEnd,
          propStart: pb.sourceStart,
          propEnd: pb.sourceEnd,
          proposedText,
        });
      }
      seam = bb.sourceEnd;
    } else {
      hunks.push({
        ordinal: (ordinal += 1),
        op: "insert",
        baseStart: seam,
        baseEnd: seam,
        propStart: pb.sourceStart,
        propEnd: pb.sourceEnd,
        proposedText,
      });
    }
  });

  // Deletes, each with its zero-width proposed junction point: the end of
  // the nearest surviving base block's proposed source (before the junction
  // whitespace, tracked as a running index so the whole pass is O(n)), or
  // the end of the frontmatter region when nothing survives before it.
  let lastCarriedProposed: number | undefined;
  baseBlocks.forEach((bb, i) => {
    const jp = carriedToProposed.get(i);
    if (jp !== undefined) {
      lastCarriedProposed = jp;
      return;
    }
    const point =
      lastCarriedProposed !== undefined
        ? (proposedBlocks[lastCarriedProposed]?.sourceEnd ?? propFmEnd)
        : propFmEnd;
    hunks.push({
      ordinal: (ordinal += 1),
      op: "delete",
      baseStart: bb.sourceStart,
      baseEnd: bb.sourceEnd,
      propStart: point,
      propEnd: point,
      proposedText: "",
    });
  });

  return hunks;
}

export type ApplyHunksInput = Readonly<{
  base: string;
  proposed: string;
  // Every hunk the reviewer did NOT accept (rejected or still pending at
  // apply time). All-accepted is the degenerate case: zero reverts, and the
  // output is the proposed document verbatim.
  rejected: readonly Hunk[];
}>;

const trailingWs = (s: string): string => /\s*$/.exec(s)?.[0] ?? "";
const leadingWs = (s: string): string => /^\s*/.exec(s)?.[0] ?? "";

// The post-review document: the PROPOSED markdown with each rejected hunk
// reverted. One forward walk over the proposed bytes; hunks are
// non-overlapping proposed ranges (deletes zero-width at their junction).
// Reverts by op:
//   replace — the base bytes come back in the proposed block's place; the
//     separators around it stay as the proposer wrote them.
//   insert — the block never arrives: its bytes vanish along with exactly
//     ONE junction separator — the leading one when the walk still has one
//     to consume before the block; otherwise the trailing one (the document
//     head, or stacked directly on another reverted hunk that already
//     consumed the lead).
//   delete — the block never leaves: its base bytes re-enter at the
//     junction, attached to the survivor before it by their base-side
//     leading separator. At the document head there is no survivor to
//     attach to, so the block carries its base trailing separator instead —
//     and a RUN of head deletes at the same junction chains that way.
// Everything else — untouched blocks, accepted hunks, the whitespace
// between them — flows through as proposed bytes: spacing under a mixed
// decision set is proposed-authoritative (never re-synthesized), which is
// what keeps a tight list tight.
export function applyHunks(input: ApplyHunksInput): string {
  const { base, proposed } = input;
  // Proposed order; zero-width junctions sort before a block starting at
  // the same offset; base order (ordinal) breaks delete ties.
  const ordered = [...input.rejected].sort(
    (a, b) =>
      a.propStart - b.propStart ||
      a.propEnd - b.propEnd ||
      a.ordinal - b.ordinal,
  );
  let out = "";
  let cursor = 0;
  // The junction point of an in-progress document-head delete run (-1 when
  // none): later deletes at the SAME point keep carrying trailing
  // separators even though re-inserted bytes now precede them.
  let headRunAt = -1;
  for (const h of ordered) {
    if (h.propStart < cursor) continue; // defensive: skip an overlap
    const gap = proposed.slice(cursor, h.propStart);
    cursor = h.propEnd;
    const contentBefore = /\S/.test(out) || /\S/.test(gap);
    if (h.op === "delete") {
      const bytes = base.slice(h.baseStart, h.baseEnd);
      if (contentBefore && headRunAt !== h.propStart) {
        out += gap + trailingWs(base.slice(0, h.baseStart)) + bytes;
      } else {
        out += gap + bytes + leadingWs(base.slice(h.baseEnd));
        headRunAt = h.propStart;
      }
      continue;
    }
    headRunAt = -1;
    if (h.op === "insert") {
      const lead = trailingWs(gap);
      if (lead === "") {
        out += gap;
        cursor += leadingWs(proposed.slice(cursor)).length;
      } else {
        out += gap.slice(0, gap.length - lead.length);
      }
      continue;
    }
    out += gap + base.slice(h.baseStart, h.baseEnd);
  }
  return out + proposed.slice(cursor);
}
