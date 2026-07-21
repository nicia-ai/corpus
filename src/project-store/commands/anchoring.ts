import {
  asBlockId,
  BLOCK_PARSER_VERSION,
  type Block,
  type BlockId,
  matchBlocks,
  type MatchedBlock,
  type MatchResult,
  parseBlocks,
} from "@nicia-ai/prose-diff";

import type { BlockMapEntry, CommentThreadRow, StoredBlockMap } from "../../db";
import { asBlockId as asCorpusBlockId } from "../../ids";
import { type Anchor, rebaseAnchors } from "../../store/domain/anchor";
import type { DocumentNode } from "../../store/repos/document-repo";
import type { ProjectCommandContext } from "../command";

// Block-map maintenance + anchor rebase, run inside the save transaction.
// The block map (stable ids + kind, tagged by parser version) is the
// non-canonical side state that lets a comment anchor survive edits and
// moves. Lazy: nothing runs unless the document has an open thread.

// Reconstruct a version's blocks (id + kind + text) from its stored map and
// markdown — ONLY when the parser is provably the one that produced the map
// (version tag + per-position kind/count match). On any mismatch returns
// undefined, and the caller treats the previous version as unmappable so
// anchors re-resolve by text quote. Block text is recovered by re-parsing
// the blob, never stored twice.
function reconstruct(
  stored: StoredBlockMap | undefined,
  markdown: string | undefined,
): readonly Block[] | undefined {
  if (stored === undefined || markdown === undefined) return undefined;
  if (stored.parserVersion !== BLOCK_PARSER_VERSION) return undefined;
  const parsed = parseBlocks(markdown);
  if (parsed.length !== stored.blocks.length) return undefined;
  const out: Block[] = [];
  for (let i = 0; i < parsed.length; i += 1) {
    const p = parsed[i];
    const s = stored.blocks[i];
    if (p === undefined || s === undefined) return undefined;
    if (p.kind !== s.kind) return undefined;
    out.push({ id: asBlockId(s.id), kind: p.kind, text: p.text });
  }
  return out;
}

const toEntries = (blocks: readonly MatchedBlock[]): readonly BlockMapEntry[] =>
  blocks.map((b) => ({ id: b.id, kind: b.kind }));

const threadToAnchor = (t: CommentThreadRow): Anchor => ({
  blockId: asCorpusBlockId(t.anchorBlockId),
  start: t.anchorStart,
  end: t.anchorEnd,
  quote: { prefix: t.quotePrefix, exact: t.quoteExact, suffix: t.quoteSuffix },
});

// Parse `markdown`, match it against `prev`, persist the resulting map at
// `docVersion`, and advance the per-document block-id ordinal (ids are
// minted monotonically and never reused).
async function persistMatch(
  ctx: ProjectCommandContext,
  slug: string,
  docVersion: number,
  prev: readonly Block[],
  markdown: string,
): Promise<MatchResult> {
  const next = parseBlocks(markdown);
  let ordinal = await ctx.u.blockMaps.nextOrdinal(slug);
  const mintId = (): BlockId => {
    const id = asBlockId(`${slug}:${ordinal.toString()}`);
    ordinal += 1;
    return id;
  };
  const match = matchBlocks({ prev, next, mintId });
  await ctx.u.blockMaps.putMap(
    slug,
    docVersion,
    BLOCK_PARSER_VERSION,
    toEntries(match.blocks),
  );
  await ctx.u.blockMaps.setOrdinal(slug, ordinal);
  return match;
}

// The head version's blocks with ids, building + persisting the map if it
// is absent or stale. Used when a comment is first anchored to a document.
export async function ensureHeadBlockMap(
  ctx: ProjectCommandContext,
  slug: string,
  head: DocumentNode,
): Promise<readonly Block[]> {
  const markdown = (await ctx.u.blobs.get(head.contentHash)) ?? "";
  const stored = await ctx.u.blockMaps.headMap(slug);
  if (stored?.docVersion === head.docVersion) {
    const blocks = reconstruct(stored, markdown);
    if (blocks !== undefined) return blocks;
  }
  const match = await persistMatch(ctx, slug, head.docVersion, [], markdown);
  return match.blocks.map((b) => ({ id: b.id, kind: b.kind, text: b.text }));
}

// Called from the save path AFTER the new version is written. Re-maps the
// document's blocks and rebases every open thread's anchor onto the new
// version — relocating it, or marking it orphaned when its quoted text is
// gone. Skips all work when the document has no open threads.
export async function maintainAnchorsOnSave(
  ctx: ProjectCommandContext,
  args: Readonly<{
    slug: string;
    docVersion: number;
    markdown: string;
    head: DocumentNode | undefined;
  }>,
): Promise<void> {
  const { slug, docVersion, markdown, head } = args;
  if (!(await ctx.u.comments.hasOpenThreads(slug))) return;

  let prev: readonly Block[] = [];
  if (head !== undefined) {
    const stored = await ctx.u.blockMaps.headMap(slug);
    if (stored?.docVersion === head.docVersion) {
      const prevMarkdown = await ctx.u.blobs.get(head.contentHash);
      prev = reconstruct(stored, prevMarkdown) ?? [];
    }
  }

  const match = await persistMatch(ctx, slug, docVersion, prev, markdown);
  const open = await ctx.u.comments.openThreads(slug);
  const results = rebaseAnchors(open.map(threadToAnchor), match);
  await Promise.all(
    open.map((thread, i) => {
      const r = results[i];
      if (r === undefined) return Promise.resolve();
      return r.status === "anchored"
        ? ctx.u.comments.updateAnchor(thread.id, {
            blockId: r.anchor.blockId,
            start: r.anchor.start,
            end: r.anchor.end,
            quote: r.anchor.quote,
          })
        : ctx.u.comments.markOrphaned(thread.id);
    }),
  );
}
