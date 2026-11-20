import { InternalError } from "../../errors";
import { asCorpusSlug, asDocumentSlug, type CorpusSlug } from "../../ids";
import { asFolderSlug } from "../../ids";
import {
  documentMovedIn,
  documentMovedOut,
  MEMBERSHIP_REASON_MOVED,
} from "../../store/domain/change-events";
import {
  DEFAULT_CORPUS_SLUG,
  PROMOTED_DEFAULT_DESCRIPTION,
  PROMOTED_DEFAULT_NAME,
  PROMOTED_DEFAULT_SLUG,
} from "../../store/domain/default-corpus";
import type { DomainChange, ProjectCommandContext } from "../command";

import { createCorpusCommand } from "./corpora";
import {
  corpusTreeChanged,
  ensureCorpusRoot,
  liveDocumentsUnder,
} from "./corpus-tree";

export type PromoteDefaultResult = Readonly<{
  // The ordinary corpus now holding the former default corpus's pages.
  corpusSlug: CorpusSlug;
  changes: readonly DomainChange[];
}>;

// Turn the default corpus's pages into an ordinary, served corpus and leave
// the default corpus as an empty drafts space. The default corpus's slug IS
// the drafts identity (`corpusIsServed`), so it cannot also be a served
// corpus: the pages move, as one tree move, under the root of a new corpus
// (history, comments, proposals and share links travel by slug), and the
// caller re-points the credentials at the returned slug.
//
// Idempotent across a retry: a corpus carrying `PROMOTED_DEFAULT_DESCRIPTION`
// at the chosen slug is the one an earlier attempt made, and its pages are
// not moved again (anything in drafts since is a draft, not a served page).
export async function promoteDefaultCorpusCommand(
  ctx: ProjectCommandContext,
  changedBy: string,
): Promise<PromoteDefaultResult | undefined> {
  const defaultRoot = await ensureCorpusRoot(ctx, DEFAULT_CORPUS_SLUG);
  if (defaultRoot === undefined) return undefined;

  let corpusSlug = asCorpusSlug(PROMOTED_DEFAULT_SLUG);
  let existing = await ctx.u.cols.findCorpus(corpusSlug);
  for (let n = 2; existing !== undefined; n += 1) {
    if (existing.description === PROMOTED_DEFAULT_DESCRIPTION) {
      return { corpusSlug, changes: [] };
    }
    corpusSlug = asCorpusSlug(`${PROMOTED_DEFAULT_SLUG}-${String(n)}`);
    existing = await ctx.u.cols.findCorpus(corpusSlug);
  }

  const created = await createCorpusCommand(ctx, {
    slug: corpusSlug,
    name: PROMOTED_DEFAULT_NAME,
    description: PROMOTED_DEFAULT_DESCRIPTION,
    changedBy,
  });
  const newRoot = await ensureCorpusRoot(ctx, corpusSlug);
  if (newRoot === undefined) {
    throw new InternalError("the promoted corpus has no root folder");
  }
  const moved = await liveDocumentsUnder(ctx, defaultRoot);
  const tree = (await ctx.u.folders.subtree(defaultRoot)).get(defaultRoot);
  for (const child of tree?.childFolders ?? []) {
    const result = await ctx.u.folders.move(asFolderSlug(child.slug), newRoot);
    if (!result.ok) {
      throw new InternalError(`could not promote a folder: ${result.reason}`);
    }
  }
  await ctx.u.folders.rehomeDocuments(
    newRoot,
    await ctx.u.docs.findMany(
      (tree?.documents ?? []).map((d) => asDocumentSlug(d.slug)),
    ),
  );
  const changes: DomainChange[] = [
    ...created.changes,
    ...moved.flatMap((documentSlug) => [
      documentMovedOut({
        corpusSlug: DEFAULT_CORPUS_SLUG,
        documentSlug,
        toCorpusSlug: corpusSlug,
        reason: MEMBERSHIP_REASON_MOVED,
        changedBy,
        changedAt: ctx.now,
      }),
      documentMovedIn({
        corpusSlug,
        documentSlug,
        fromCorpusSlug: DEFAULT_CORPUS_SLUG,
        changedBy,
        changedAt: ctx.now,
      }),
    ]),
    ...(await corpusTreeChanged(
      ctx,
      [DEFAULT_CORPUS_SLUG, corpusSlug],
      changedBy,
      "membership",
    )),
  ];
  return { corpusSlug, changes };
}
