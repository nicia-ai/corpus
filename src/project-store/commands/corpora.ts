import type { CorpusSlug, DocumentSlug, FolderSlug } from "../../ids";
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
import type { CollectionDelivery } from "../../store/domain/collection-expand";
import { collectionVersionSnapshot } from "../../store/domain/versions";
import { DEFAULT_ALWAYS_INCLUDE_BUDGET_TOKENS } from "../../util";
import type {
  CommandOutcome,
  DomainChange,
  ProjectCommandContext,
} from "../command";
import type { UpdateCorpusInput } from "../contracts";

export type CreateCorpusCommandInput = Readonly<{
  slug: CorpusSlug;
  name: string;
  description?: string;
  alwaysIncludeBudgetTokens?: number;
  changedBy: string;
}>;

export async function createCorpusCommand(
  ctx: ProjectCommandContext,
  input: CreateCorpusCommandInput,
): Promise<CommandOutcome<{ slug: CorpusSlug }>> {
  if ((await ctx.u.cols.findCorpus(input.slug)) !== undefined) {
    return { result: { slug: input.slug }, changes: [] };
  }
  await ctx.u.cols.createCorpus({
    slug: input.slug,
    name: input.name,
    description: input.description,
    alwaysIncludeBudgetTokens:
      input.alwaysIncludeBudgetTokens ?? DEFAULT_ALWAYS_INCLUDE_BUDGET_TOKENS,
  });
  const colNode = await ctx.u.cols.findCorpus(input.slug);
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
    corpusSlug: input.slug,
    name: input.name,
    changedBy: input.changedBy,
    changedAt: ctx.now,
  });
  return { result: { slug: input.slug }, changes: [change] };
}

export async function attachDocumentCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{
    corpusSlug: CorpusSlug;
    documentSlug: DocumentSlug;
    position: number;
    delivery: CollectionDelivery;
    changedBy: string;
  }>,
): Promise<CommandOutcome<{ ok: boolean }>> {
  const outcome = await ctx.u.cols.attach(
    input.corpusSlug,
    input.documentSlug,
    input.position,
    input.delivery,
  );
  if (!outcome.ok || outcome.change === "unchanged") {
    return { result: { ok: false }, changes: [] };
  }
  await ctx.corpus.snapshot(ctx.u, input.corpusSlug, input.changedBy, ctx.now);
  const change = documentAttached({
    corpusSlug: input.corpusSlug,
    documentSlug: input.documentSlug,
    position: input.position,
    previousPosition:
      outcome.change === "reordered" ? outcome.previousPosition : undefined,
    changedBy: input.changedBy,
    changedAt: ctx.now,
  });
  return { result: { ok: true }, changes: [change] };
}

// Attach many documents in one shot, appended after the corpus's
// current members in the given order, with a single snapshot. Documents
// already in the corpus (or archived/missing) are left untouched —
// idempotent re-upload, no reordering, no duplicate event. The repo's
// `attachMany` does the membership work in one read pass; this layer
// turns the result into change events and cuts one CorpusVersion.
export async function attachDocumentsToCorpusCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{
    corpusSlug: CorpusSlug;
    documentSlugs: readonly DocumentSlug[];
    delivery: CollectionDelivery;
    changedBy: string;
  }>,
): Promise<CommandOutcome<{ attached: number }>> {
  const attached = await ctx.u.cols.attachMany(
    input.corpusSlug,
    input.documentSlugs,
    input.delivery,
  );
  if (attached.length === 0) return { result: { attached: 0 }, changes: [] };

  const changes: DomainChange[] = attached.map((a) =>
    documentAttached({
      corpusSlug: input.corpusSlug,
      documentSlug: a.slug,
      position: a.position,
      previousPosition: undefined,
      changedBy: input.changedBy,
      changedAt: ctx.now,
    }),
  );
  await ctx.corpus.snapshot(ctx.u, input.corpusSlug, input.changedBy, ctx.now);
  return { result: { attached: attached.length }, changes };
}

export async function updateCorpusCommand(
  ctx: ProjectCommandContext,
  input: UpdateCorpusInput,
): Promise<
  CommandOutcome<Readonly<{ status: "missing" | "noop" | "changed" }>>
> {
  const nextDescription = input.description ?? "";
  const col = await ctx.u.cols.findCorpus(input.slug);
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
  await ctx.u.cols.updateCorpus(input.slug, {
    name: input.name,
    description: nextDescription,
    alwaysIncludeBudgetTokens: nextBudget,
  });
  const change = collectionUpdated({
    corpusSlug: input.slug,
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

async function corpusMutationCommand<T>(
  ctx: ProjectCommandContext,
  corpusSlug: CorpusSlug,
  changedBy: string,
  mutate: () => Promise<CollectionChange | undefined>,
  result: (change: CollectionChange | undefined) => T,
): Promise<CommandOutcome<T>> {
  const change = await mutate();
  if (change !== undefined) {
    await ctx.corpus.snapshot(ctx.u, corpusSlug, changedBy, ctx.now);
  }
  return {
    result: result(change),
    changes: change === undefined ? [] : [change],
  };
}

export async function detachDocumentCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{
    corpusSlug: CorpusSlug;
    documentSlug: DocumentSlug;
    changedBy: string;
  }>,
): Promise<CommandOutcome<{ ok: boolean }>> {
  return corpusMutationCommand(
    ctx,
    input.corpusSlug,
    input.changedBy,
    async () => {
      const position = await ctx.u.cols.detach(
        input.corpusSlug,
        input.documentSlug,
      );
      if (position === undefined) return undefined;
      return documentDetached({
        corpusSlug: input.corpusSlug,
        documentSlug: input.documentSlug,
        position,
        changedBy: input.changedBy,
        changedAt: ctx.now,
      });
    },
    (change) => ({ ok: change !== undefined }),
  );
}

export async function reorderCorpusDocumentsCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{
    corpusSlug: CorpusSlug;
    orderedDocumentSlugs: readonly DocumentSlug[];
    changedBy: string;
  }>,
): Promise<CommandOutcome<{ ok: boolean }>> {
  return corpusMutationCommand(
    ctx,
    input.corpusSlug,
    input.changedBy,
    async () => {
      const ok = await ctx.u.cols.setOrder(
        input.corpusSlug,
        input.orderedDocumentSlugs,
      );
      if (!ok) return undefined;
      return collectionReordered({
        corpusSlug: input.corpusSlug,
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
    corpusSlug: CorpusSlug;
    documentSlug: DocumentSlug;
    delivery: CollectionDelivery;
    changedBy: string;
  }>,
): Promise<CommandOutcome<{ ok: boolean }>> {
  return corpusMutationCommand(
    ctx,
    input.corpusSlug,
    input.changedBy,
    async () => {
      const outcome = await ctx.u.cols.setDelivery(
        input.corpusSlug,
        input.documentSlug,
        input.delivery,
      );
      if (!outcome?.changed) return undefined;
      return collectionDeliveryChanged({
        corpusSlug: input.corpusSlug,
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
    corpusSlug: CorpusSlug;
    folderSlug: FolderSlug;
    delivery: CollectionDelivery;
    changedBy: string;
  }>,
): Promise<CommandOutcome<{ ok: boolean }>> {
  return corpusMutationCommand(
    ctx,
    input.corpusSlug,
    input.changedBy,
    async () => {
      const outcome = await ctx.u.cols.setFolderDelivery(
        input.corpusSlug,
        input.folderSlug,
        input.delivery,
      );
      if (!outcome?.changed) return undefined;
      return collectionDeliveryChanged({
        corpusSlug: input.corpusSlug,
        folderSlug: input.folderSlug,
        delivery: input.delivery,
        changedBy: input.changedBy,
        changedAt: ctx.now,
      });
    },
    (change) => ({ ok: change !== undefined }),
  );
}

export async function attachFolderToCorpusCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{
    corpusSlug: CorpusSlug;
    folderSlug: FolderSlug;
    position: number;
    delivery: CollectionDelivery;
    changedBy: string;
  }>,
): Promise<CommandOutcome<{ ok: boolean }>> {
  return corpusMutationCommand(
    ctx,
    input.corpusSlug,
    input.changedBy,
    async () => {
      const outcome = await ctx.u.cols.attachFolder(
        input.corpusSlug,
        input.folderSlug,
        input.position,
        input.delivery,
      );
      if (!outcome.ok || outcome.change === "unchanged") return undefined;
      return folderAttached({
        corpusSlug: input.corpusSlug,
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

export async function detachFolderFromCorpusCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{
    corpusSlug: CorpusSlug;
    folderSlug: FolderSlug;
    changedBy: string;
  }>,
): Promise<CommandOutcome<{ ok: boolean }>> {
  return corpusMutationCommand(
    ctx,
    input.corpusSlug,
    input.changedBy,
    async () => {
      const position = await ctx.u.cols.detachFolder(
        input.corpusSlug,
        input.folderSlug,
      );
      if (position === undefined) return undefined;
      return folderDetached({
        corpusSlug: input.corpusSlug,
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
  corpusSlug: CorpusSlug;
  documentSlug?: DocumentSlug;
  folderSlug?: FolderSlug;
  changedBy: string;
}>;
