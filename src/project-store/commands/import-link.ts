import { asFolderSlug, type CollectionSlug } from "../../ids";
import type { CollectionDelivery } from "../../store/domain/collection-expand";
import type {
  CommandOutcome,
  DomainChange,
  ProjectCommandContext,
} from "../command";
import type { ImportCollectionLink } from "../contracts";

import {
  attachFolderToCollectionCommand,
  createCollectionCommand,
} from "./collections";

export async function linkImportedRootFolderCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{
    rootFolderName: string;
    collectionSlug: CollectionSlug;
    link: Exclude<ImportCollectionLink, Readonly<{ mode: "none" }>>;
    delivery: CollectionDelivery;
    changedBy: string;
  }>,
): Promise<CommandOutcome<Readonly<{ linkedTo: CollectionSlug | undefined }>>> {
  const changes: DomainChange[] = [];

  // mode='new': honor "create me a new collection" even if the folder
  // lookup later misses, but refuse silent slug-collision attaches —
  // slugify('Docs') landing on an unrelated existing 'docs' collection
  // would otherwise expose that collection's contents to the uploader.
  if (input.link.mode === "new") {
    const existing = await ctx.u.cols.findCollection(input.collectionSlug);
    if (existing !== undefined && existing.name !== input.link.name) {
      return { result: { linkedTo: undefined }, changes };
    }
    const created = await createCollectionCommand(ctx, {
      slug: input.collectionSlug,
      name: input.link.name,
      changedBy: input.changedBy,
    });
    changes.push(...created.changes);
  } else if (
    (await ctx.u.cols.findCollection(input.collectionSlug)) === undefined
  ) {
    // mode='existing' with a stale slug — don't attempt the attach.
    return { result: { linkedTo: undefined }, changes };
  }

  const folder = (await ctx.u.folders.listAll()).find(
    (f) => f.parentSlug === null && f.name === input.rootFolderName,
  );
  if (folder === undefined) {
    return { result: { linkedTo: undefined }, changes };
  }

  const attached = await attachFolderToCollectionCommand(ctx, {
    collectionSlug: input.collectionSlug,
    folderSlug: asFolderSlug(folder.slug),
    position: 0,
    delivery: input.delivery,
    changedBy: input.changedBy,
  });
  changes.push(...attached.changes);

  // attached.result.ok=false here means the attach was a no-op (folder
  // already linked at this same slot — idempotent re-upload); the link
  // still exists, so surface the slug to the caller regardless.
  return {
    result: { linkedTo: input.collectionSlug },
    changes,
  };
}
