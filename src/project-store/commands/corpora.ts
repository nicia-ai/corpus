import type { CorpusSlug } from "../../ids";
import {
  collectionCreated,
  collectionUpdated,
} from "../../store/domain/change-events";
import { collectionVersionSnapshot } from "../../store/domain/versions";
import type { CommandOutcome, ProjectCommandContext } from "../command";
import type { UpdateCorpusInput } from "../contracts";

import { ensureCorpusRoot } from "./corpus-tree";

export type CreateCorpusCommandInput = Readonly<{
  slug: CorpusSlug;
  name: string;
  description?: string;
  changedBy: string;
}>;

// A corpus and its root folder are created together, so a corpus is never
// without the one place its documents can live. Idempotent on slug (and
// self-healing: an existing corpus missing its root gets one).
export async function createCorpusCommand(
  ctx: ProjectCommandContext,
  input: CreateCorpusCommandInput,
): Promise<CommandOutcome<{ slug: CorpusSlug }>> {
  if ((await ctx.u.cols.findCorpus(input.slug)) !== undefined) {
    await ensureCorpusRoot(ctx, input.slug);
    return { result: { slug: input.slug }, changes: [] };
  }
  const corpus = await ctx.u.cols.createCorpus({
    slug: input.slug,
    name: input.name,
    description: input.description,
  });
  await ensureCorpusRoot(ctx, input.slug);
  await ctx.u.versions.appendCollectionVersion(
    corpus.id,
    collectionVersionSnapshot({
      collectionSlug: input.slug,
      collectionVersion: 1,
      members: [],
      changedAt: ctx.now,
      changedBy: input.changedBy,
    }),
  );
  const change = collectionCreated({
    corpusSlug: input.slug,
    name: input.name,
    changedBy: input.changedBy,
    changedAt: ctx.now,
  });
  return { result: { slug: input.slug }, changes: [change] };
}

// Name/description only. The slug — and with it the root folder — is
// untouched, so renaming a corpus changes no corpus-relative path and
// cuts no CorpusVersion.
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
  if (col.name === input.name && (col.description ?? "") === nextDescription) {
    return { result: { status: "noop" }, changes: [] };
  }
  await ctx.u.cols.updateCorpus(input.slug, {
    name: input.name,
    description: nextDescription,
  });
  const change = collectionUpdated({
    corpusSlug: input.slug,
    before: { name: col.name, description: col.description },
    after: {
      name: input.name,
      description: nextDescription === "" ? undefined : nextDescription,
    },
    changedBy: input.changedBy,
    changedAt: ctx.now,
  });
  return { result: { status: "changed" }, changes: [change] };
}
