import { asCorpusSlug, asDocumentSlug } from "../../ids";
import {
  EXAMPLE_ATTACHMENTS,
  EXAMPLE_COLLECTIONS,
  EXAMPLE_DOCS,
} from "../../sample-project";
import { DEFAULT_COLLECTION_DELIVERY } from "../../store/domain/collection-expand";
import {
  DEFAULT_CORPUS_SLUG,
  isDefaultCorpusSlug,
} from "../../store/domain/default-corpus";
import type { DomainChange, ProjectCommandContext } from "../command";
import type { SeedResult } from "../contracts";

import { attachDocumentCommand, createCorpusCommand } from "./corpora";
import { saveDocumentCommand } from "./documents";

async function projectIsSeedable(ctx: ProjectCommandContext): Promise<boolean> {
  const { u } = ctx;
  const [docs, cols] = await Promise.all([u.docs.list(1), u.cols.list(1)]);
  if (docs.length > 0) return false;
  if (cols.length === 0) return true;
  const onlyCol = cols[0];
  if (
    cols.length === 1 &&
    onlyCol !== undefined &&
    isDefaultCorpusSlug(asCorpusSlug(onlyCol.slug))
  ) {
    const entries = await u.cols.entries(DEFAULT_CORPUS_SLUG);
    if (entries === undefined) return false;
    return entries.documents.length === 0 && entries.folders.length === 0;
  }
  return false;
}

export async function seedExampleCommand(
  ctx: ProjectCommandContext,
  changedBy: string,
): Promise<Readonly<{ result: SeedResult; changes: readonly DomainChange[] }>> {
  // Emptiness guard inside the tx (not a pre-read) so two racing
  // seeds can't both pass it: a populated project is a no-op,
  // never a partial double-seed or a version-conflict throw. An empty
  // default corpus alone still counts as seedable.
  if (!(await projectIsSeedable(ctx))) {
    return {
      result: { seeded: false, reason: "not_empty" },
      changes: [],
    };
  }
  const changes: DomainChange[] = [];
  for (const d of EXAMPLE_DOCS) {
    const saved = await saveDocumentCommand(ctx, {
      slug: asDocumentSlug(d.slug),
      title: d.title,
      markdown: d.markdown,
      clientVersion: 0,
      changedBy,
    });
    changes.push(...saved.changes);
  }
  for (const c of EXAMPLE_COLLECTIONS) {
    const created = await createCorpusCommand(ctx, {
      slug: asCorpusSlug(c.slug),
      name: c.name,
      changedBy,
    });
    changes.push(...created.changes);
  }
  for (const a of EXAMPLE_ATTACHMENTS) {
    const attached = await attachDocumentCommand(ctx, {
      corpusSlug: asCorpusSlug(a.corpusSlug),
      documentSlug: asDocumentSlug(a.documentSlug),
      position: a.position,
      delivery: DEFAULT_COLLECTION_DELIVERY,
      changedBy,
    });
    changes.push(...attached.changes);
  }
  return { result: { seeded: true }, changes };
}
