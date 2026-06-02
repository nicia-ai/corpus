import { asFolderSlug, type DocumentSlug, type FolderSlug } from "../../ids";
import {
  collectionFolderTreeChanged,
  type CollectionChange,
} from "../../store/domain/change-events";
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
import { isDocumentChange } from "../command";

import { archiveOneDocumentCommand } from "./documents";
import { folderTreeFanOutChanges } from "./folder-fanout";

async function withFolderTreeFanOutCommand<
  T extends Readonly<{ ok: boolean; changed?: boolean }>,
>(
  ctx: ProjectCommandContext,
  changedBy: string,
  op: () => Promise<T>,
): Promise<CommandOutcome<T>> {
  const result = await op();
  const changes =
    result.ok && result.changed !== false
      ? await folderTreeFanOutChanges(ctx.u, changedBy, ctx.now)
      : [];
  return { result, changes };
}

export async function createFolderCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{ name: string; parentSlug: FolderSlug | null }>,
): Promise<
  CommandOutcome<
    Readonly<
      { ok: true; slug: string } | { ok: false; reason: "segment-collision" }
    >
  >
> {
  const taken = new Set((await ctx.u.folders.listAll()).map((f) => f.slug));
  const slug = asFolderSlug(normalizeSlug(input.name, taken));
  const outcome = await ctx.u.folders.create({
    slug,
    name: input.name,
    createdAt: ctx.now,
    parentSlug: input.parentSlug,
  });
  return {
    result: outcome.ok
      ? { ok: true, slug: outcome.node.slug }
      : { ok: false, reason: outcome.reason },
    changes: [],
  };
}

export function renameFolderCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{
    slug: FolderSlug;
    name: string;
    changedBy: string;
  }>,
): Promise<CommandOutcome<RenameFolderResult>> {
  return withFolderTreeFanOutCommand(ctx, input.changedBy, () =>
    ctx.u.folders.rename(input.slug, input.name),
  );
}

export function moveFolderCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{
    slug: FolderSlug;
    newParentSlug: FolderSlug | null;
    changedBy: string;
  }>,
): Promise<CommandOutcome<MoveFolderResult>> {
  return withFolderTreeFanOutCommand(ctx, input.changedBy, () =>
    ctx.u.folders.move(input.slug, input.newParentSlug),
  );
}

export async function deleteFolderCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{
    slug: FolderSlug;
    changedBy: string;
  }>,
): Promise<CommandOutcome<DeleteFolderResult>> {
  const changes: DomainChange[] = [];
  const r = await ctx.u.folders.delete(input.slug);
  if (!r.ok) return { result: r, changes: [] };

  for (const ds of r.documentSlugs) {
    const archived = await archiveOneDocumentCommand(ctx, {
      slug: ds,
      changedBy: input.changedBy,
    });
    changes.push(...archived.changes);
  }

  const alreadySnapshotted = new Set(
    changes
      .filter((c): c is CollectionChange => !isDocumentChange(c))
      .map((c) => c.collectionSlug),
  );
  for (const cs of r.unlinkedCollections) {
    if (alreadySnapshotted.has(cs)) continue;
    await ctx.collection.snapshot(ctx.u, cs, input.changedBy, ctx.now);
    changes.push(
      collectionFolderTreeChanged({
        collectionSlug: cs,
        changedBy: input.changedBy,
        changedAt: ctx.now,
      }),
    );
  }

  changes.push(
    ...(await folderTreeFanOutChanges(ctx.u, input.changedBy, ctx.now)),
  );
  return { result: r, changes };
}

export function placeDocumentInFolderCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{
    documentSlug: DocumentSlug;
    folderSlug: FolderSlug | null;
    changedBy: string;
  }>,
): Promise<CommandOutcome<PlaceDocumentResult>> {
  return withFolderTreeFanOutCommand(ctx, input.changedBy, () =>
    ctx.u.folders.placeDocument(input.documentSlug, input.folderSlug),
  );
}

export async function placeDocumentsInFolderCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{
    documentSlugs: readonly DocumentSlug[];
    folderSlug: FolderSlug | null;
    changedBy: string;
  }>,
): Promise<CommandOutcome<Readonly<{ moved: number; failed: number }>>> {
  let moved = 0;
  let failed = 0;
  let changed = false;
  for (const slug of input.documentSlugs) {
    const r = await ctx.u.folders.placeDocument(slug, input.folderSlug);
    if (!r.ok) failed += 1;
    else {
      moved += 1;
      if (r.changed) changed = true;
    }
  }
  const changes: readonly DomainChange[] = changed
    ? await folderTreeFanOutChanges(ctx.u, input.changedBy, ctx.now)
    : [];
  return { result: { moved, failed }, changes };
}
