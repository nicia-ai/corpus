import { InternalError } from "../../errors";
import {
  asDocumentSlug,
  asFolderSlug,
  type DocumentSlug,
  type FolderSlug,
} from "../../ids";
import {
  collectionDeleted,
  documentMovedIn,
} from "../../store/domain/change-events";
import {
  DEFAULT_CORPUS_SLUG,
  isDefaultCorpusSlug,
} from "../../store/domain/default-corpus";
import { normalizeSlug } from "../../store/domain/paths";
import type {
  CommandOutcome,
  DomainChange,
  ProjectCommandContext,
} from "../command";
import type { DeleteCorpusInput, DeleteCorpusResult } from "../contracts";

import {
  corpusTreeChanged,
  ensureCorpusRoot,
  liveDocumentsUnder,
} from "./corpus-tree";
import { archiveOneDocumentCommand } from "./documents";
import { ensureDefaultCorpusCommand } from "./ensure-default-corpus";
import { isUnsafePathChar } from "./untrusted-path";

// A corpus's display name as one path segment: separators and control
// characters become spaces. Nothing left (or `.` / `..`) = no usable name.
function pathSafeName(name: string): string | undefined {
  const safe = Array.from(name)
    .map((c) => (c === "/" || isUnsafePathChar(c) ? " " : c))
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  return safe === "" || safe === "." || safe === ".." ? undefined : safe;
}

// The first free name for the folder a deleted corpus's pages are kept in
// (`handbook`, then `handbook-2`, …) among the default corpus's top level.
async function freeFolderName(
  ctx: ProjectCommandContext,
  parentSlug: FolderSlug,
  wanted: string,
): Promise<string> {
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? wanted : `${wanted}-${String(n)}`;
    if (!(await ctx.u.folders.slotOccupied(parentSlug, candidate))) {
      return candidate;
    }
  }
}

// Keep a deleted corpus's pages as drafts: its whole tree moves, intact,
// into one new folder of the default corpus named after the corpus — so
// two corpora that both held `README.md` can never collide there.
async function movePagesToDefault(
  ctx: ProjectCommandContext,
  input: DeleteCorpusInput,
  corpusName: string,
  rootSlug: FolderSlug,
): Promise<Readonly<{ moved: number; changes: readonly DomainChange[] }>> {
  const tree = await ctx.u.folders.subtree(rootSlug);
  const root = tree.get(rootSlug);
  if (
    root === undefined ||
    (root.childFolders.length === 0 && root.documents.length === 0)
  ) {
    return { moved: 0, changes: [] };
  }
  const ensured = await ensureDefaultCorpusCommand(ctx, input.changedBy);
  const defaultRoot = await ensureCorpusRoot(ctx, DEFAULT_CORPUS_SLUG);
  if (defaultRoot === undefined) {
    throw new InternalError("the default corpus has no root folder");
  }
  const moved = await liveDocumentsUnder(ctx, rootSlug);
  const taken = new Set((await ctx.u.folders.listAll()).map((f) => f.slug));
  const kept = await ctx.u.folders.create({
    slug: asFolderSlug(normalizeSlug(input.slug, taken)),
    name: await freeFolderName(
      ctx,
      defaultRoot,
      pathSafeName(corpusName) ?? input.slug,
    ),
    createdAt: ctx.now,
    parentSlug: defaultRoot,
  });
  if (!kept.ok) {
    throw new InternalError(`could not keep pages: ${kept.reason}`);
  }
  const keptSlug = asFolderSlug(kept.node.slug);
  for (const child of root.childFolders) {
    const moved = await ctx.u.folders.move(asFolderSlug(child.slug), keptSlug);
    if (!moved.ok) {
      throw new InternalError(`could not keep a folder: ${moved.reason}`);
    }
  }
  for (const doc of root.documents) {
    await ctx.u.folders.rehomeDocument(asDocumentSlug(doc.slug), keptSlug);
  }
  return {
    moved: moved.length,
    changes: [
      ...ensured.changes,
      ...moved.map((documentSlug) =>
        documentMovedIn({
          corpusSlug: DEFAULT_CORPUS_SLUG,
          documentSlug,
          fromCorpusSlug: input.slug,
          changedBy: input.changedBy,
          changedAt: ctx.now,
        }),
      ),
      ...(await corpusTreeChanged(
        ctx,
        [DEFAULT_CORPUS_SLUG],
        input.changedBy,
        "membership",
      )),
    ],
  };
}

// Delete a corpus and decide what becomes of its pages: archived with it
// (the ordinary, recoverable soft delete) or kept as drafts. The default
// corpus is the drafts space itself and cannot be deleted. The corpus
// node, its root link and its snapshots go; credentials bound to it are
// the control plane's to revoke (see the `deleteCorpus` server fn).
export async function deleteCorpusCommand(
  ctx: ProjectCommandContext,
  input: DeleteCorpusInput,
): Promise<CommandOutcome<DeleteCorpusResult>> {
  if (isDefaultCorpusSlug(input.slug)) {
    return { result: { ok: false, reason: "default-corpus" }, changes: [] };
  }
  const corpus = await ctx.u.cols.findCorpus(input.slug);
  if (corpus === undefined) {
    return { result: { ok: false, reason: "missing" }, changes: [] };
  }
  const rootSlug = await ensureCorpusRoot(ctx, input.slug);
  const changes: DomainChange[] = [];
  let moved = 0;
  if (rootSlug !== undefined && input.pages === "move-to-default") {
    const kept = await movePagesToDefault(ctx, input, corpus.name, rootSlug);
    moved = kept.moved;
    changes.push(...kept.changes);
  }
  await ctx.u.cols.deleteCorpus(corpus);
  const archivedSlugs: DocumentSlug[] = [];
  if (rootSlug !== undefined) {
    const removed = await ctx.u.folders.delete(rootSlug);
    for (const slug of removed.ok ? removed.documentSlugs : []) {
      const outcome = await archiveOneDocumentCommand(ctx, {
        slug,
        changedBy: input.changedBy,
      });
      if (outcome.result.archived) archivedSlugs.push(slug);
      changes.push(...outcome.changes);
    }
  }
  changes.push(
    collectionDeleted({
      corpusSlug: input.slug,
      name: corpus.name,
      pages: input.pages,
      changedBy: input.changedBy,
      changedAt: ctx.now,
    }),
  );
  return { result: { ok: true, archivedSlugs, moved }, changes };
}
