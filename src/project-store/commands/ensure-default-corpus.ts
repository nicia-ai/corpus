import type { CorpusSlug } from "../../ids";
import {
  DEFAULT_CORPUS_DESCRIPTION,
  DEFAULT_CORPUS_NAME,
  DEFAULT_CORPUS_SLUG,
} from "../../store/domain/default-corpus";
import type { DomainChange, ProjectCommandContext } from "../command";

import { createCorpusCommand } from "./corpora";
import { ensureCorpusRoot } from "./corpus-tree";

export type EnsureDefaultCorpusResult = Readonly<{
  slug: CorpusSlug;
  created: boolean;
}>;

export async function ensureDefaultCorpusCommand(
  ctx: ProjectCommandContext,
  changedBy: string,
): Promise<
  Readonly<{
    result: EnsureDefaultCorpusResult;
    changes: readonly DomainChange[];
  }>
> {
  const existing = await ctx.u.cols.findCorpus(DEFAULT_CORPUS_SLUG);
  if (existing !== undefined) {
    await ensureCorpusRoot(ctx, DEFAULT_CORPUS_SLUG);
    return {
      result: { slug: DEFAULT_CORPUS_SLUG, created: false },
      changes: [],
    };
  }
  const created = await createCorpusCommand(ctx, {
    slug: DEFAULT_CORPUS_SLUG,
    name: DEFAULT_CORPUS_NAME,
    description: DEFAULT_CORPUS_DESCRIPTION,
    changedBy,
  });
  return {
    result: { slug: DEFAULT_CORPUS_SLUG, created: true },
    changes: created.changes,
  };
}
