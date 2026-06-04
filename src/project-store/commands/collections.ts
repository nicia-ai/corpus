import type { CollectionSlug, DocumentSlug, FolderSlug } from "../../ids";
import {
  collectionDeliveryChanged,
  collectionCreated,
  collectionReordered,
  collectionUpdated,
  documentAttached,
  documentDetached,
  folderAttached,
  folderDetached,
  type CollectionChange,
} from "../../store/domain/change-events";
import {
  DEFAULT_COLLECTION_DELIVERY,
  type CollectionDelivery,
} from "../../store/domain/collection-expand";
import { collectionVersionSnapshot } from "../../store/domain/versions";
import { DEFAULT_ALWAYS_INCLUDE_BUDGET_TOKENS } from "../../util";
import type {
  CommandOutcome,
  DomainChange,
  ProjectCommandContext,
} from "../command";
import type { UpdateCollectionInput } from "../contracts";

export type CreateCollectionCommandInput = Readonly<{
  slug: CollectionSlug;
  name: string;
  description?: string;
  alwaysIncludeBudgetTokens?: number;
  changedBy: string;
}>;

export async function createCollectionCommand(
  ctx: ProjectCommandContext,
  input: CreateCollectionCommandInput,
): Promise<CommandOutcome<{ slug: CollectionSlug }>> {
  if ((await ctx.u.cols.findCollection(input.slug)) !== undefined) {
    return { result: { slug: input.slug }, changes: [] };
  }
  await ctx.u.cols.createCollection({
    slug: input.slug,
    name: input.name,
    description: input.description,
    alwaysIncludeBudgetTokens:
      input.alwaysIncludeBudgetTokens ?? DEFAULT_ALWAYS_INCLUDE_BUDGET_TOKENS,
  });
  const colNode = await ctx.u.cols.findCollection(input.slug);
  if (colNode !== undefined) {
    await ctx.u.versions.appendCollectionVersion(
      colNode.id,
      collectionVersionSnapshot({
        collectionSlug: input.slug,
        collectionVersion: 1,
        members: [],
        changedAt: ctx.now,
        changedBy: input.changedBy,
      }),
    );
  }
  const change = collectionCreated({
    collectionSlug: input.slug,
    name: input.name,
    changedBy: input.changedBy,
    changedAt: ctx.now,
  });
  return { result: { slug: input.slug }, changes: [change] };
}

export async function attachDocumentCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{
    collectionSlug: CollectionSlug;
    documentSlug: DocumentSlug;
    position: number;
    delivery?: CollectionDelivery;
    changedBy: string;
  }>,
): Promise<CommandOutcome<{ ok: boolean }>> {
  const delivery = input.delivery ?? DEFAULT_COLLECTION_DELIVERY;
  const outcome = await ctx.u.cols.attach(
    input.collectionSlug,
    input.documentSlug,
    input.position,
    delivery,
  );
  if (!outcome.ok || outcome.change === "unchanged") {
    return { result: { ok: false }, changes: [] };
  }
  await ctx.collection.snapshot(
    ctx.u,
    input.collectionSlug,
    input.changedBy,
    ctx.now,
  );
  const change = documentAttached({
    collectionSlug: input.collectionSlug,
    documentSlug: input.documentSlug,
    position: input.position,
    previousPosition:
      outcome.change === "reordered" ? outcome.previousPosition : undefined,
    changedBy: input.changedBy,
    changedAt: ctx.now,
  });
  return { result: { ok: true }, changes: [change] };
}

// Attach many documents in one shot, appended after the collection's
// current members in the given order, with a single snapshot. Documents
// already in the collection (or archived/missing) are left untouched —
// idempotent re-upload, no reordering, no duplicate event. The repo's
// `attachMany` does the membership work in one read pass; this layer
// turns the result into change events and cuts one CollectionVersion.
export async function attachDocumentsToCollectionCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{
    collectionSlug: CollectionSlug;
    documentSlugs: readonly DocumentSlug[];
    delivery?: CollectionDelivery;
    changedBy: string;
  }>,
): Promise<CommandOutcome<{ attached: number }>> {
  const delivery = input.delivery ?? DEFAULT_COLLECTION_DELIVERY;
  const attached = await ctx.u.cols.attachMany(
    input.collectionSlug,
    input.documentSlugs,
    delivery,
  );
  if (attached.length === 0) return { result: { attached: 0 }, changes: [] };

  const changes: DomainChange[] = attached.map((a) =>
    documentAttached({
      collectionSlug: input.collectionSlug,
      documentSlug: a.slug,
      position: a.position,
      previousPosition: undefined,
      changedBy: input.changedBy,
      changedAt: ctx.now,
    }),
  );
  await ctx.collection.snapshot(
    ctx.u,
    input.collectionSlug,
    input.changedBy,
    ctx.now,
  );
  return { result: { attached: attached.length }, changes };
}

export async function updateCollectionCommand(
  ctx: ProjectCommandContext,
  input: UpdateCollectionInput,
): Promise<
  CommandOutcome<Readonly<{ status: "missing" | "noop" | "changed" }>>
> {
  const nextDescription = input.description ?? "";
  const col = await ctx.u.cols.findCollection(input.slug);
  if (col === undefined) {
    return { result: { status: "missing" }, changes: [] };
  }
  const nextBudget =
    input.alwaysIncludeBudgetTokens ?? col.alwaysIncludeBudgetTokens;
  if (
    col.name === input.name &&
    (col.description ?? "") === nextDescription &&
    col.alwaysIncludeBudgetTokens === nextBudget
  ) {
    return { result: { status: "noop" }, changes: [] };
  }
  await ctx.u.cols.updateCollection(input.slug, {
    name: input.name,
    description: nextDescription,
    alwaysIncludeBudgetTokens: nextBudget,
  });
  const change = collectionUpdated({
    collectionSlug: input.slug,
    before: {
      name: col.name,
      description: col.description,
      alwaysIncludeBudgetTokens: col.alwaysIncludeBudgetTokens,
    },
    after: {
      name: input.name,
      description: nextDescription === "" ? undefined : nextDescription,
      alwaysIncludeBudgetTokens: nextBudget,
    },
    changedBy: input.changedBy,
    changedAt: ctx.now,
  });
  return {
    result: { status: "changed" },
    changes: [change],
  };
}

async function collectionMutationCommand<T>(
  ctx: ProjectCommandContext,
  collectionSlug: CollectionSlug,
  changedBy: string,
  mutate: () => Promise<CollectionChange | undefined>,
  result: (change: CollectionChange | undefined) => T,
): Promise<CommandOutcome<T>> {
  const change = await mutate();
  if (change !== undefined) {
    await ctx.collection.snapshot(ctx.u, collectionSlug, changedBy, ctx.now);
  }
  return {
    result: result(change),
    changes: change === undefined ? [] : [change],
  };
}

export async function detachDocumentCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{
    collectionSlug: CollectionSlug;
    documentSlug: DocumentSlug;
    changedBy: string;
  }>,
): Promise<CommandOutcome<{ ok: boolean }>> {
  return collectionMutationCommand(
    ctx,
    input.collectionSlug,
    input.changedBy,
    async () => {
      const position = await ctx.u.cols.detach(
        input.collectionSlug,
        input.documentSlug,
      );
      if (position === undefined) return undefined;
      return documentDetached({
        collectionSlug: input.collectionSlug,
        documentSlug: input.documentSlug,
        position,
        changedBy: input.changedBy,
        changedAt: ctx.now,
      });
    },
    (change) => ({ ok: change !== undefined }),
  );
}

export async function reorderCollectionDocumentsCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{
    collectionSlug: CollectionSlug;
    orderedDocumentSlugs: readonly DocumentSlug[];
    changedBy: string;
  }>,
): Promise<CommandOutcome<{ ok: boolean }>> {
  return collectionMutationCommand(
    ctx,
    input.collectionSlug,
    input.changedBy,
    async () => {
      const ok = await ctx.u.cols.setOrder(
        input.collectionSlug,
        input.orderedDocumentSlugs,
      );
      if (!ok) return undefined;
      return collectionReordered({
        collectionSlug: input.collectionSlug,
        order: input.orderedDocumentSlugs,
        changedBy: input.changedBy,
        changedAt: ctx.now,
      });
    },
    (change) => ({ ok: change !== undefined }),
  );
}

export async function setMemberDeliveryCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{
    collectionSlug: CollectionSlug;
    documentSlug: DocumentSlug;
    delivery: CollectionDelivery;
    changedBy: string;
  }>,
): Promise<CommandOutcome<{ ok: boolean }>> {
  return collectionMutationCommand(
    ctx,
    input.collectionSlug,
    input.changedBy,
    async () => {
      const outcome = await ctx.u.cols.setDelivery(
        input.collectionSlug,
        input.documentSlug,
        input.delivery,
      );
      if (!outcome?.changed) return undefined;
      return collectionDeliveryChanged({
        collectionSlug: input.collectionSlug,
        documentSlug: input.documentSlug,
        delivery: input.delivery,
        changedBy: input.changedBy,
        changedAt: ctx.now,
      });
    },
    (change) => ({ ok: change !== undefined }),
  );
}

export async function setFolderLinkDeliveryCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{
    collectionSlug: CollectionSlug;
    folderSlug: FolderSlug;
    delivery: CollectionDelivery;
    changedBy: string;
  }>,
): Promise<CommandOutcome<{ ok: boolean }>> {
  return collectionMutationCommand(
    ctx,
    input.collectionSlug,
    input.changedBy,
    async () => {
      const outcome = await ctx.u.cols.setFolderDelivery(
        input.collectionSlug,
        input.folderSlug,
        input.delivery,
      );
      if (!outcome?.changed) return undefined;
      return collectionDeliveryChanged({
        collectionSlug: input.collectionSlug,
        folderSlug: input.folderSlug,
        delivery: input.delivery,
        changedBy: input.changedBy,
        changedAt: ctx.now,
      });
    },
    (change) => ({ ok: change !== undefined }),
  );
}

export async function attachFolderToCollectionCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{
    collectionSlug: CollectionSlug;
    folderSlug: FolderSlug;
    position: number;
    delivery?: CollectionDelivery;
    changedBy: string;
  }>,
): Promise<CommandOutcome<{ ok: boolean }>> {
  const delivery = input.delivery ?? DEFAULT_COLLECTION_DELIVERY;
  return collectionMutationCommand(
    ctx,
    input.collectionSlug,
    input.changedBy,
    async () => {
      const outcome = await ctx.u.cols.attachFolder(
        input.collectionSlug,
        input.folderSlug,
        input.position,
        delivery,
      );
      if (!outcome.ok || outcome.change === "unchanged") return undefined;
      return folderAttached({
        collectionSlug: input.collectionSlug,
        folderSlug: input.folderSlug,
        position: input.position,
        previousPosition:
          outcome.change === "reordered" ? outcome.previousPosition : undefined,
        changedBy: input.changedBy,
        changedAt: ctx.now,
      });
    },
    (change) => ({ ok: change !== undefined }),
  );
}

export async function detachFolderFromCollectionCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{
    collectionSlug: CollectionSlug;
    folderSlug: FolderSlug;
    changedBy: string;
  }>,
): Promise<CommandOutcome<{ ok: boolean }>> {
  return collectionMutationCommand(
    ctx,
    input.collectionSlug,
    input.changedBy,
    async () => {
      const position = await ctx.u.cols.detachFolder(
        input.collectionSlug,
        input.folderSlug,
      );
      if (position === undefined) return undefined;
      return folderDetached({
        collectionSlug: input.collectionSlug,
        folderSlug: input.folderSlug,
        position,
        changedBy: input.changedBy,
        changedAt: ctx.now,
      });
    },
    (change) => ({ ok: change !== undefined }),
  );
}

export type CollectionMemberChangeInput = Readonly<{
  collectionSlug: CollectionSlug;
  documentSlug?: DocumentSlug;
  folderSlug?: FolderSlug;
  changedBy: string;
}>;
