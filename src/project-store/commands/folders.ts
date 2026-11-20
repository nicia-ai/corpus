import {
  asFolderSlug,
  type CorpusSlug,
  type DocumentSlug,
  type FolderSlug,
} from "../../ids";
import {
  documentMovedIn,
  documentMovedOut,
  MEMBERSHIP_REASON_MOVED,
} from "../../store/domain/change-events";
import type { CorpusLocation } from "../../store/domain/corpus-drive";
import { normalizeSlug } from "../../store/domain/paths";
import type {
  DeleteFolderResult,
  MoveFolderResult,
  PlaceDocumentResult,
  RenameFolderResult,
} from "../../store/repos/folder-repo";
import type {
  CommandOutcome,
  DomainChange,
  ProjectCommandContext,
} from "../command";
import type { MoveDocumentsResult } from "../contracts";

import {
  corpusOfDocument,
  corpusOfEveryDocument,
  corpusOfFolder,
  corpusTreeChanged,
  isCorpusRoot,
  liveDocumentsUnder,
  resolveCorpusFolder,
} from "./corpus-tree";
import { archiveOneDocumentCommand } from "./documents";

const MISSING = { ok: false, reason: "missing" } as const;

export type CreateFolderResult = Readonly<
  | { ok: true; slug: string }
  | { ok: false; reason: "segment-collision" | "missing" }
>;

// Slug is derived from the name at creation (collision-suffixed against
// existing folder slugs) and stable thereafter. A new, empty folder
// changes no document's path, so creation records nothing.
export async function createFolderCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{ name: string; location: CorpusLocation }>,
): Promise<CommandOutcome<CreateFolderResult>> {
  const parentSlug = await resolveCorpusFolder(ctx.u, input.location);
  if (parentSlug === undefined) return { result: MISSING, changes: [] };
  const taken = new Set((await ctx.u.folders.listAll()).map((f) => f.slug));
  const outcome = await ctx.u.folders.create({
    slug: asFolderSlug(normalizeSlug(input.name, taken)),
    name: input.name,
    createdAt: ctx.now,
    parentSlug,
  });
  return {
    result: outcome.ok
      ? { ok: true, slug: outcome.node.slug }
      : { ok: false, reason: outcome.reason },
    changes: [],
  };
}

export async function renameFolderCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{ slug: FolderSlug; name: string; changedBy: string }>,
): Promise<CommandOutcome<RenameFolderResult>> {
  if (await isCorpusRoot(ctx.u, input.slug)) {
    return { result: MISSING, changes: [] };
  }
  const corpusSlug = await corpusOfFolder(ctx.u, input.slug);
  const result = await ctx.u.folders.rename(input.slug, input.name);
  const changes =
    result.ok && result.changed && corpusSlug !== undefined
      ? await corpusTreeChanged(ctx, [corpusSlug], input.changedBy, "paths")
      : [];
  return { result, changes };
}

// One "left A" + one "joined B" event per document that crossed corpora,
// then a fresh snapshot of each side. Everything attached to a document —
// history, comments, proposals, share links — is keyed by its slug and
// never touched: a move is an edge change in the tree and nothing else.
async function crossCorpusMoveChanges(
  ctx: ProjectCommandContext,
  moves: readonly Readonly<{
    documentSlug: DocumentSlug;
    from: CorpusSlug;
    to: CorpusSlug;
  }>[],
  changedBy: string,
): Promise<readonly DomainChange[]> {
  const changes: DomainChange[] = moves.flatMap((move) => [
    documentMovedOut({
      corpusSlug: move.from,
      documentSlug: move.documentSlug,
      toCorpusSlug: move.to,
      reason: MEMBERSHIP_REASON_MOVED,
      changedBy,
      changedAt: ctx.now,
    }),
    documentMovedIn({
      corpusSlug: move.to,
      documentSlug: move.documentSlug,
      fromCorpusSlug: move.from,
      changedBy,
      changedAt: ctx.now,
    }),
  ]);
  const touched = moves.flatMap((move) => [move.from, move.to]);
  return [
    ...changes,
    ...(await corpusTreeChanged(ctx, touched, changedBy, "membership")),
  ];
}

// Move a folder to another place in its corpus, or into another corpus —
// the same tree move either way.
export async function moveFolderCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{
    slug: FolderSlug;
    destination: CorpusLocation;
    changedBy: string;
  }>,
): Promise<CommandOutcome<MoveFolderResult>> {
  if (await isCorpusRoot(ctx.u, input.slug)) {
    return { result: MISSING, changes: [] };
  }
  const [from, parentSlug] = await Promise.all([
    corpusOfFolder(ctx.u, input.slug),
    resolveCorpusFolder(ctx.u, input.destination),
  ]);
  if (from === undefined || parentSlug === undefined) {
    return { result: MISSING, changes: [] };
  }
  const result = await ctx.u.folders.move(input.slug, parentSlug);
  if (!result.ok || !result.changed) return { result, changes: [] };
  const to = input.destination.corpusSlug;
  if (from === to) {
    return {
      result,
      changes: await corpusTreeChanged(ctx, [from], input.changedBy, "paths"),
    };
  }
  const moved = await liveDocumentsUnder(ctx, input.slug);
  return {
    result,
    changes: await crossCorpusMoveChanges(
      ctx,
      moved.map((documentSlug) => ({ documentSlug, from, to })),
      input.changedBy,
    ),
  };
}

// Cascade delete of an ordinary folder: its documents are archived (the
// soft delete documents get everywhere), its subfolders removed.
export async function deleteFolderCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{ slug: FolderSlug; changedBy: string }>,
): Promise<CommandOutcome<DeleteFolderResult>> {
  if (await isCorpusRoot(ctx.u, input.slug)) {
    return { result: MISSING, changes: [] };
  }
  const corpusSlug = await corpusOfFolder(ctx.u, input.slug);
  const result = await ctx.u.folders.delete(input.slug);
  if (!result.ok) return { result, changes: [] };
  const changes: DomainChange[] = [];
  for (const slug of result.documentSlugs) {
    const archived = await archiveOneDocumentCommand(ctx, {
      slug,
      changedBy: input.changedBy,
    });
    changes.push(...archived.changes);
  }
  if (corpusSlug !== undefined) {
    changes.push(
      ...(await corpusTreeChanged(
        ctx,
        [corpusSlug],
        input.changedBy,
        "membership",
      )),
    );
  }
  return { result, changes };
}

type DocumentMove = Readonly<{
  result: PlaceDocumentResult;
  crossed: Readonly<{ from: CorpusSlug; to: CorpusSlug }> | undefined;
  within: CorpusSlug | undefined;
}>;

function documentMove(
  result: PlaceDocumentResult,
  from: CorpusSlug | undefined,
  to: CorpusSlug,
): DocumentMove {
  const changed = result.ok && result.changed;
  return {
    result,
    crossed:
      changed && from !== undefined && from !== to ? { from, to } : undefined,
    within: changed && from === to ? to : undefined,
  };
}

async function moveOneDocument(
  ctx: ProjectCommandContext,
  documentSlug: DocumentSlug,
  folderSlug: FolderSlug,
  to: CorpusSlug,
): Promise<DocumentMove> {
  const from = await corpusOfDocument(ctx.u, documentSlug);
  const result = await ctx.u.folders.placeDocument(documentSlug, folderSlug);
  return documentMove(result, from, to);
}

// The same move for a set: heads, current corpora and current edges are all
// set reads, so only the edge writes scale with the number of documents.
async function moveManyDocuments(
  ctx: ProjectCommandContext,
  documentSlugs: readonly DocumentSlug[],
  folderSlug: FolderSlug,
  to: CorpusSlug,
): Promise<
  readonly Readonly<{ documentSlug: DocumentSlug; move: DocumentMove }>[]
> {
  const [heads, corpusOf] = await Promise.all([
    ctx.u.docs.findMany(documentSlugs),
    corpusOfEveryDocument(ctx.u),
  ]);
  const results = await ctx.u.folders.placeDocuments(heads, folderSlug);
  return documentSlugs.map((documentSlug, i) => ({
    documentSlug,
    move: documentMove(results[i] ?? MISSING, corpusOf.get(documentSlug), to),
  }));
}

async function documentMoveChanges(
  ctx: ProjectCommandContext,
  moves: readonly Readonly<{
    documentSlug: DocumentSlug;
    move: DocumentMove;
  }>[],
  changedBy: string,
): Promise<readonly DomainChange[]> {
  const crossed = moves.flatMap(({ documentSlug, move }) =>
    move.crossed === undefined ? [] : [{ documentSlug, ...move.crossed }],
  );
  const within = moves.flatMap(({ move }) =>
    move.within === undefined ? [] : [move.within],
  );
  return [
    ...(await crossCorpusMoveChanges(ctx, crossed, changedBy)),
    ...(await corpusTreeChanged(ctx, within, changedBy, "paths")),
  ];
}

// Move one document to a place in any corpus. Moving it out of the
// default corpus into a named one is what publishes it; moving it back
// unpublishes it.
export async function moveDocumentCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{
    documentSlug: DocumentSlug;
    destination: CorpusLocation;
    changedBy: string;
  }>,
): Promise<CommandOutcome<PlaceDocumentResult>> {
  const folderSlug = await resolveCorpusFolder(ctx.u, input.destination);
  if (folderSlug === undefined) return { result: MISSING, changes: [] };
  const move = await moveOneDocument(
    ctx,
    input.documentSlug,
    folderSlug,
    input.destination.corpusSlug,
  );
  return {
    result: move.result,
    changes: await documentMoveChanges(
      ctx,
      [{ documentSlug: input.documentSlug, move }],
      input.changedBy,
    ),
  };
}

// Bulk move into one place, best-effort in a single tx: a per-document
// collision is a no-op (placeDocument never mutates on failure), so the
// ones that can move do, and the rest are counted.
export async function moveDocumentsCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{
    documentSlugs: readonly DocumentSlug[];
    destination: CorpusLocation;
    changedBy: string;
  }>,
): Promise<CommandOutcome<MoveDocumentsResult>> {
  const folderSlug = await resolveCorpusFolder(ctx.u, input.destination);
  if (folderSlug === undefined) {
    return {
      result: { moved: 0, failed: input.documentSlugs.length },
      changes: [],
    };
  }
  const moves = await moveManyDocuments(
    ctx,
    input.documentSlugs,
    folderSlug,
    input.destination.corpusSlug,
  );
  const moved = moves.filter(({ move }) => move.result.ok).length;
  return {
    result: { moved, failed: moves.length - moved },
    changes: await documentMoveChanges(ctx, moves, input.changedBy),
  };
}
