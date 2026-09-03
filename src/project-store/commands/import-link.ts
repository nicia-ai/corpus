import type { CorpusSlug, DocumentSlug, FolderSlug } from "../../ids";
import type { CollectionDelivery } from "../../store/domain/collection-expand";
import type {
  CommandOutcome,
  DomainChange,
  ProjectCommandContext,
} from "../command";
import type { ImportCorpusLink } from "../contracts";

import {
  attachDocumentsToCorpusCommand,
  attachFolderToCorpusCommand,
  createCorpusCommand,
} from "./corpora";

type LinkResult = CommandOutcome<
  Readonly<{ linkedTo: CorpusSlug | undefined }>
>;

type ResolvedLink = Exclude<ImportCorpusLink, Readonly<{ mode: "none" }>>;

// Ensure the link target corpus exists: create it for mode='new'
// (honoring the user's name) or confirm it for mode='existing'. Returns
// ok=false when the link should be abandoned — a mode='new' slug
// collision with an unrelated corpus, or a mode='existing' slug gone
// stale. Refusing the slug-collision attach matters: slugify('Docs')
// landing on an existing 'docs' would otherwise expose that corpus's
// contents to the uploader.
async function ensureLinkCorpus(
  ctx: ProjectCommandContext,
  input: Readonly<{
    corpusSlug: CorpusSlug;
    link: ResolvedLink;
    changedBy: string;
  }>,
): Promise<Readonly<{ ok: boolean; changes: readonly DomainChange[] }>> {
  if (input.link.mode === "new") {
    const existing = await ctx.u.cols.findCorpus(input.corpusSlug);
    if (existing !== undefined && existing.name !== input.link.name) {
      return { ok: false, changes: [] };
    }
    const created = await createCorpusCommand(ctx, {
      slug: input.corpusSlug,
      name: input.link.name,
      changedBy: input.changedBy,
    });
    return { ok: true, changes: created.changes };
  }
  if ((await ctx.u.cols.findCorpus(input.corpusSlug)) === undefined) {
    return { ok: false, changes: [] };
  }
  return { ok: true, changes: [] };
}

// The next position in the corpus's shared document+folder space —
// reduce, not arg-spread, so a large corpus can't overflow the call
// stack.
async function nextPosition(
  ctx: ProjectCommandContext,
  corpusSlug: CorpusSlug,
): Promise<number> {
  const entries = await ctx.u.cols.entries(corpusSlug);
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
// live link: documents added to the folder later join the corpus.
export async function linkImportedFolderCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{
    folderSlug: FolderSlug;
    corpusSlug: CorpusSlug;
    link: ResolvedLink;
    delivery: CollectionDelivery;
    changedBy: string;
  }>,
): Promise<LinkResult> {
  const corpus = await ensureLinkCorpus(ctx, {
    corpusSlug: input.corpusSlug,
    link: input.link,
    changedBy: input.changedBy,
  });
  if (!corpus.ok) {
    return { result: { linkedTo: undefined }, changes: corpus.changes };
  }

  const attached = await attachFolderToCorpusCommand(ctx, {
    corpusSlug: input.corpusSlug,
    folderSlug: input.folderSlug,
    position: await nextPosition(ctx, input.corpusSlug),
    delivery: input.delivery,
    changedBy: input.changedBy,
  });
  // attached.ok=false here means the link already existed (idempotent
  // re-upload); the link still holds, so surface the slug regardless.
  return {
    result: { linkedTo: input.corpusSlug },
    changes: [...corpus.changes, ...attached.changes],
  };
}

// Link the uploaded documents themselves — the default when the upload
// went to the root or merged into a folder that already existed.
export async function linkImportedDocumentsCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{
    documentSlugs: readonly DocumentSlug[];
    corpusSlug: CorpusSlug;
    link: ResolvedLink;
    delivery: CollectionDelivery;
    changedBy: string;
  }>,
): Promise<LinkResult> {
  const corpus = await ensureLinkCorpus(ctx, {
    corpusSlug: input.corpusSlug,
    link: input.link,
    changedBy: input.changedBy,
  });
  if (!corpus.ok) {
    return { result: { linkedTo: undefined }, changes: corpus.changes };
  }

  const attached = await attachDocumentsToCorpusCommand(ctx, {
    corpusSlug: input.corpusSlug,
    documentSlugs: input.documentSlugs,
    delivery: input.delivery,
    changedBy: input.changedBy,
  });
  return {
    result: { linkedTo: input.corpusSlug },
    changes: [...corpus.changes, ...attached.changes],
  };
}
