import type { CollectionSlug, DocumentSlug, FolderSlug } from "../../ids";
import type { CollectionDelivery } from "../../store/domain/collection-expand";
import type {
  CommandOutcome,
  DomainChange,
  ProjectCommandContext,
} from "../command";
import type { ImportCollectionLink } from "../contracts";

import {
  attachDocumentsToCollectionCommand,
  attachFolderToCollectionCommand,
  createCollectionCommand,
} from "./collections";

type LinkResult = CommandOutcome<
  Readonly<{ linkedTo: CollectionSlug | undefined }>
>;

type ResolvedLink = Exclude<ImportCollectionLink, Readonly<{ mode: "none" }>>;

// Ensure the link target collection exists: create it for mode='new'
// (honoring the user's name) or confirm it for mode='existing'. Returns
// ok=false when the link should be abandoned — a mode='new' slug
// collision with an unrelated collection, or a mode='existing' slug gone
// stale. Refusing the slug-collision attach matters: slugify('Docs')
// landing on an existing 'docs' would otherwise expose that collection's
// contents to the uploader.
async function ensureLinkCollection(
  ctx: ProjectCommandContext,
  input: Readonly<{
    collectionSlug: CollectionSlug;
    link: ResolvedLink;
    changedBy: string;
  }>,
): Promise<Readonly<{ ok: boolean; changes: readonly DomainChange[] }>> {
  if (input.link.mode === "new") {
    const existing = await ctx.u.cols.findCollection(input.collectionSlug);
    if (existing !== undefined && existing.name !== input.link.name) {
      return { ok: false, changes: [] };
    }
    const created = await createCollectionCommand(ctx, {
      slug: input.collectionSlug,
      name: input.link.name,
      changedBy: input.changedBy,
    });
    return { ok: true, changes: created.changes };
  }
  if ((await ctx.u.cols.findCollection(input.collectionSlug)) === undefined) {
    return { ok: false, changes: [] };
  }
  return { ok: true, changes: [] };
}

// The next position in the collection's shared document+folder space —
// reduce, not arg-spread, so a large collection can't overflow the call
// stack.
async function nextPosition(
  ctx: ProjectCommandContext,
  collectionSlug: CollectionSlug,
): Promise<number> {
  const entries = await ctx.u.cols.entries(collectionSlug);
  if (entries === undefined) return 0;
  return (
    [...entries.documents, ...entries.folders].reduce(
      (max, e) => Math.max(max, e.position),
      -1,
    ) + 1
  );
}

// Link the upload's fresh wrapper folder (resolved server-side by the DO
// from what the import created — never by a client-supplied path). The
// live link: documents added to the folder later join the collection.
export async function linkImportedFolderCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{
    folderSlug: FolderSlug;
    collectionSlug: CollectionSlug;
    link: ResolvedLink;
    delivery: CollectionDelivery;
    changedBy: string;
  }>,
): Promise<LinkResult> {
  const collection = await ensureLinkCollection(ctx, {
    collectionSlug: input.collectionSlug,
    link: input.link,
    changedBy: input.changedBy,
  });
  if (!collection.ok) {
    return { result: { linkedTo: undefined }, changes: collection.changes };
  }

  const attached = await attachFolderToCollectionCommand(ctx, {
    collectionSlug: input.collectionSlug,
    folderSlug: input.folderSlug,
    position: await nextPosition(ctx, input.collectionSlug),
    delivery: input.delivery,
    changedBy: input.changedBy,
  });
  // attached.ok=false here means the link already existed (idempotent
  // re-upload); the link still holds, so surface the slug regardless.
  return {
    result: { linkedTo: input.collectionSlug },
    changes: [...collection.changes, ...attached.changes],
  };
}

// Link the uploaded documents themselves — the default when the upload
// went to the root or merged into a folder that already existed.
export async function linkImportedDocumentsCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{
    documentSlugs: readonly DocumentSlug[];
    collectionSlug: CollectionSlug;
    link: ResolvedLink;
    delivery: CollectionDelivery;
    changedBy: string;
  }>,
): Promise<LinkResult> {
  const collection = await ensureLinkCollection(ctx, {
    collectionSlug: input.collectionSlug,
    link: input.link,
    changedBy: input.changedBy,
  });
  if (!collection.ok) {
    return { result: { linkedTo: undefined }, changes: collection.changes };
  }

  const attached = await attachDocumentsToCollectionCommand(ctx, {
    collectionSlug: input.collectionSlug,
    documentSlugs: input.documentSlugs,
    delivery: input.delivery,
    changedBy: input.changedBy,
  });
  return {
    result: { linkedTo: input.collectionSlug },
    changes: [...collection.changes, ...attached.changes],
  };
}
