import { asBlockId, type BlockId } from "../../ids";
import { isBlank } from "../../util";

import { type Block, matchBlocks, type NextBlock } from "./block-match";
import { parseBlocksWithRanges } from "./block-parse";
import { frontmatterLength } from "./frontmatter";

// Suggestions as block-level hunks. A suggestion is a proposed alternative
// markdown for a document; `diffToHunks` turns base+proposed into an ordered
// list of block edits (each carrying a source range in the BASE), and
// `applyHunks` splices a chosen subset back into the base to produce the new
// markdown. Pure, zero-IO.
//
// Byte fidelity is the contract: block matching identifies blocks by their
// PLAIN text (the right lens for anchor identity — a moved or lightly
// edited block keeps its comments), but the diff below compares SOURCE
// BYTES, so a formatting-only edit (`**bold**` → `*bold*`) still yields a
// hunk, and hunks carry the separator bytes the proposer actually wrote so
// applying them reproduces the proposal's spacing (a tight list stays
// tight). diffToHunks verifies this per instance and degrades to a
// whole-document hunk when granular hunks cannot uphold it — see its
// contract comment below.
//
// v1 captures replace / insert / delete at block granularity. A pure MOVE
// (same content relocated) carries as unchanged and yields no hunk — moves
// are not represented in a suggestion yet.

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
  // The separator bytes around this block in the PROPOSED source, captured
  // so applyHunks can splice what the proposer actually wrote instead of
  // synthesizing "\n\n" (which would loosen a tight list). Semantics by op:
  //   insert / replace — leadSep is the whitespace between the previous
  //     proposed block and this one ("" only at document start); trailSep
  //     is the whitespace after it (document trailing whitespace for the
  //     last block).
  //   delete — leadSep holds the JUNCTION: the separator standing between
  //     the surviving neighbors in the proposed source ("" at a document
  //     edge). trailSep is unused ("").
  // "" from a pre-column legacy row falls back to the old synthesized-join
  // behavior; both fields are pure whitespace by construction.
  leadSep: string;
  trailSep: string;
}>;

const baseIndexOf = (id: BlockId): number => Number(id.slice(1));

// The one whole-document hunk: the degenerate (but always-faithful) diff.
const wholeDocumentHunk = (base: string, proposed: string): Hunk => ({
  ordinal: 1,
  op: "replace",
  baseStart: 0,
  baseEnd: base.length,
  propStart: 0,
  propEnd: proposed.length,
  proposedText: proposed,
  leadSep: "",
  trailSep: "",
});

// Contract, enforced by construction for EVERY input pair:
//   diffToHunks(base, proposed) === []            ⟺  base === proposed
//   applyHunks(base, diffToHunks(base, proposed)) ===  proposed  (byte-exact)
//
// Granular block hunks are OFFERED only when they can uphold the second
// line — verified right here by actually applying them. When the block
// lens cannot represent the change faithfully (a moved block alongside
// other edits, an edited link-reference definition, spacing shifts around
// unchanged blocks), the diff degrades to ONE whole-document hunk: the
// review loses per-block granularity but can never silently drop or
// distort part of what the proposer wrote. Correctness beats granularity.
export function diffToHunks(base: string, proposed: string): readonly Hunk[] {
  if (base === proposed) return [];
  const hunks = blockHunks(base, proposed);
  // Note applying [] returns base, so the zero-hunk case (a change entirely
  // invisible to the block lens) falls through here too.
  if (applyHunks(base, hunks) === proposed) return hunks;
  return [wholeDocumentHunk(base, proposed)];
}

function blockHunks(base: string, proposed: string): readonly Hunk[] {
  const baseBlocks = parseBlocksWithRanges(base);
  const proposedBlocks = parseBlocksWithRanges(proposed);
  const prev: Block[] = baseBlocks.map((b, i) => ({
    id: asBlockId(`b${i.toString()}`),
    kind: b.kind,
    text: b.text,
  }));
  const next: NextBlock[] = proposedBlocks.map((b) => ({
    kind: b.kind,
    text: b.text,
  }));
  let minted = 0;
  const match = matchBlocks({
    prev,
    next,
    mintId: () => asBlockId(`n${(minted += 1).toString()}`),
  });

  const hunks: Hunk[] = [];
  // Where each carried base block landed in the proposed order — membership
  // marks the block as kept/edited (vs deleted), and the junction lookup
  // for deletes needs the proposed-side neighbors.
  const carriedToProposed = new Map<number, number>();
  let ordinal = 0;

  // Frontmatter is invisible to the block lens (block-parse strips it), so
  // diff the region byte-for-byte as its own hunk — otherwise a proposal's
  // frontmatter edit would silently vanish on apply. Zero-width base range
  // when the base has no fence (a prepend); the slice carries its own
  // trailing separator, so applyHunks adds none.
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
      leadSep: "",
      trailSep: "",
    });
  }

  // Separators as the proposer wrote them, relative to the emitted block
  // list. The gap between adjacent EMITTED blocks is whitespace by parser
  // construction except across node types block-parse skips (definitions,
  // footnotes); the whitespace guard keeps a skipped node's text from ever
  // being treated as a separator (degrading it to "" — the legacy join).
  const wsBetween = (from: number, to: number): string => {
    const sep = proposed.slice(from, to);
    return isBlank(sep) ? sep : "";
  };
  const sepBefore = (j: number): string => {
    const pb = proposedBlocks[j];
    if (pb === undefined) return "";
    return wsBetween(
      proposedBlocks[j - 1]?.sourceEnd ?? propFmEnd,
      pb.sourceStart,
    );
  };
  const sepAfter = (j: number): string => {
    const pb = proposedBlocks[j];
    if (pb === undefined) return "";
    return wsBetween(
      pb.sourceEnd,
      proposedBlocks[j + 1]?.sourceStart ?? proposed.length,
    );
  };

  // The base offset a new (inserted) block is anchored after: the end of
  // the most recent kept/edited base block, or the end of the frontmatter
  // region at document start.
  let seam = baseFmEnd;

  match.blocks.forEach((mb, j) => {
    const pb = proposedBlocks[j];
    if (pb === undefined) return;
    const proposedText = proposed.slice(pb.sourceStart, pb.sourceEnd);
    const origin = mb.origin;
    if (origin.status === "unchanged" || origin.status === "modified") {
      const i = baseIndexOf(origin.fromId);
      const bb = baseBlocks[i];
      if (bb === undefined) return;
      carriedToProposed.set(i, j);
      // "unchanged" means the PLAIN text matched — the right identity for
      // anchors, but not proof the bytes did. A formatting-only edit
      // (`**bold**` → `*bold*`, a reflowed soft wrap) must still be a
      // reviewable hunk, so compare the source slices.
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
          leadSep: sepBefore(j),
          trailSep: sepAfter(j),
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
        leadSep: sepBefore(j),
        trailSep: sepAfter(j),
      });
    }
  });

  // Deletes, with their junction: the separator that should stand where the
  // deleted block was — the gap following the nearest surviving base
  // block's proposed position (tracked as a running index, so the whole
  // pass is O(n)), or the proposed document's leading whitespace when
  // nothing survives before it. A move-scrambled neighborhood can make the
  // slice meaningless — the whitespace guard degrades it to "" (legacy
  // join).
  let lastCarriedProposed: number | undefined;
  baseBlocks.forEach((bb, i) => {
    const jp = carriedToProposed.get(i);
    if (jp !== undefined) {
      lastCarriedProposed = jp;
      return;
    }
    const junction =
      lastCarriedProposed !== undefined
        ? sepAfter(lastCarriedProposed)
        : wsBetween(propFmEnd, proposedBlocks[0]?.sourceStart ?? propFmEnd);
    // Zero-width proposed point where the deleted block WOULD sit: the end
    // of the nearest surviving block's proposed source (before the junction
    // whitespace), or the end of the frontmatter region when nothing
    // survives before it.
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
      leadSep: junction,
      trailSep: "",
    });
  });

  return hunks;
}

// Splice the given (already-decided) hunks into the base markdown. Hunks
// are non-overlapping block ranges; a single forward walk applies them in
// source order. Separators come from the bytes the proposer wrote (each
// hunk's leadSep / trailSep) — never synthesized — so accepted hunks keep
// their spacing: a tight list stays tight, the trailing newline survives,
// and untouched base bytes pass through verbatim. Hunks from legacy rows
// (empty separators) fall back to the old behavior: "\n\n" joins, and a
// global blank-line collapse + edge trim after a legacy delete.
export function applyHunks(base: string, hunks: readonly Hunk[]): string {
  const ordered = [...hunks].sort(
    (a, b) => a.baseStart - b.baseStart || a.ordinal - b.ordinal,
  );
  let cursor = 0;
  let out = "";
  // First index past the document's trailing whitespace — a delete whose
  // range ends at/after this point removed the final content block.
  const contentEnd = base.replace(/\s+$/, "").length;
  // Separator owed before whatever content comes next (set by a delete: the
  // junction between its surviving neighbors, verbatim — may be "").
  let pendingSep: string | undefined;
  // A just-emitted insert's trailing separator. When authoritative (the
  // hunk carries real proposed separators), it REPLACES the base separator
  // that follows — an insert can change its neighborhood's spacing (e.g. a
  // paragraph dropped into a tight list makes the next join loose). A
  // legacy row ("" separators) defers to the base bytes as it always did.
  let owedTrail: Readonly<{ sep: string; authoritative: boolean }> | undefined;
  // After a junction delete: swallow the dangling separator the removed
  // block left at the head of the next base bytes.
  let swallowLeading = false;
  // A legacy delete (no junction bytes, not at a document edge) keeps its
  // old cleanup: global blank-run collapse plus edge trims.
  let legacyCleanup = false;

  // Emit bytes sourced from the base document, honoring any pending
  // separator obligations. Pure-whitespace bytes swallowed after a junction
  // delete leave the obligations pending for the next emission.
  const emitBase = (bytes: string): void => {
    let b = bytes;
    if (swallowLeading) {
      b = b.replace(/^\s+/, "");
      if (b === "") return; // fully swallowed; keep obligations pending
      swallowLeading = false;
    }
    if (b === "") return;
    if (owedTrail !== undefined) {
      if (/^\s/.test(b)) {
        // Base bytes lead with their old separator; an authoritative trail
        // supersedes it (the proposal re-spaced this join).
        if (owedTrail.authoritative) {
          b = owedTrail.sep + b.replace(/^\s+/, "");
        }
      } else {
        out += owedTrail.sep === "" ? "\n\n" : owedTrail.sep;
      }
      owedTrail = undefined;
    }
    if (pendingSep !== undefined) {
      out += pendingSep;
      pendingSep = undefined;
    }
    out += b;
  };

  for (const h of ordered) {
    if (h.baseStart < cursor) continue; // defensive: skip an overlap
    const gap = base.slice(cursor, h.baseStart);
    cursor = h.baseEnd;

    if (h.op === "delete") {
      const atStart = h.baseStart === 0;
      const atEnd = h.baseEnd >= contentEnd;
      if (h.leadSep !== "" || atStart || atEnd) {
        // Junction mode: drop the separator that belonged to the deleted
        // block (the gap's trailing run and/or the following bytes' leading
        // run) and owe the junction separator in its place.
        emitBase(gap.replace(/\s+$/, ""));
        swallowLeading = true;
        if (owedTrail === undefined) pendingSep = h.leadSep;
        // else: an insert directly before this delete owes the join; its
        // trailing separator already reflects the proposed neighborhood.
      } else {
        // Legacy row mid-document: emit the gap untouched and let the
        // global collapse clean the doubled separator, as it always did.
        emitBase(gap);
        legacyCleanup = true;
      }
      continue;
    }

    // insert / replace — resolve the separator standing before this block.
    // A pending junction never survives into a hunk: junctions join BASE
    // pieces; a hunk brings its own leading separator (equal bytes when the
    // hunk is the junction's proposed-side neighbor).
    if (h.op === "insert") {
      // An insert's base range is zero-width at a block seam, so the gap
      // never carries this block's separator: the gap ends at a block end
      // (or is empty when stacked directly on another hunk).
      emitBase(gap);
      pendingSep = undefined;
      if (out === "") {
        out += h.leadSep; // document start: usually ""
      } else {
        out += h.leadSep === "" ? "\n\n" : h.leadSep;
      }
      out += h.proposedText;
      owedTrail = {
        sep: h.trailSep,
        // "" on both separators can only be a legacy row (a real insert has
        // a leading separator except at document start, where it has a
        // trailing one).
        authoritative: h.leadSep !== "" || h.trailSep !== "",
      };
      swallowLeading = false;
      continue;
    }

    // replace — the base gap DOES end with the separator that stood before
    // the replaced block; swap that run for the proposer's bytes so a
    // spacing change around an edited block is honored.
    if (gap === "") {
      pendingSep = undefined;
      if (out === "") {
        out += h.leadSep; // document start (incl. the frontmatter hunk)
      } else if (h.leadSep !== "") {
        out += h.leadSep;
      }
    } else if (h.leadSep === "") {
      emitBase(gap); // legacy: keep base's separator run untouched
      pendingSep = undefined;
    } else {
      emitBase(gap.replace(/\s+$/, ""));
      pendingSep = undefined;
      out += h.leadSep;
    }
    out += h.proposedText;
    owedTrail = undefined;
    swallowLeading = false;
  }

  emitBase(base.slice(cursor));
  // Obligations left standing at the end of the document: a delete of the
  // final block owes the proposal's trailing whitespace; an insert that
  // became the final block owes its own.
  if (pendingSep !== undefined) out += pendingSep;
  if (owedTrail !== undefined) out += owedTrail.sep;

  if (!legacyCleanup) return out;
  return collapseBlankRunsOutsideCode(out)
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");
}

// Collapse runs of blank lines to a single blank line (the gaps a delete
// leaves), but NEVER inside a fenced code block — there blank lines are
// significant content. Equivalent to `/\n{3,}/→\n\n` for prose while leaving
// ``` / ~~~ fences intact, so applying a suggestion can't silently rewrite a
// code sample's blank lines.
function collapseBlankRunsOutsideCode(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let fence: string | undefined;
  let blankRun = 0;
  for (const line of lines) {
    const trimmed = line.trimStart();
    const run = /^(`{3,}|~{3,})/.exec(trimmed)?.[1];
    if (fence === undefined) {
      if (run !== undefined) fence = run[0];
    } else if (run?.[0] === fence) {
      fence = undefined;
    }
    if (fence === undefined && line.trim() === "") {
      blankRun += 1;
      if (blankRun >= 2) continue; // keep at most one blank line
    } else {
      blankRun = 0;
    }
    out.push(line);
  }
  return out.join("\n");
}
