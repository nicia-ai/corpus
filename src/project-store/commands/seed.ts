import { asCollectionSlug, asDocumentSlug } from "../../ids";
import {
  EXAMPLE_ATTACHMENTS,
  EXAMPLE_COLLECTIONS,
  EXAMPLE_DOCS,
} from "../../sample-project";
import { DEFAULT_COLLECTION_DELIVERY } from "../../store/domain/collection-expand";
import type { DomainChange, ProjectCommandContext } from "../command";
import type { SeedResult } from "../contracts";

import { attachDocumentCommand, createCollectionCommand } from "./collections";
import { saveDocumentCommand } from "./documents";

export async function seedExampleCommand(
  ctx: ProjectCommandContext,
  changedBy: string,
): Promise<Readonly<{ result: SeedResult; changes: readonly DomainChange[] }>> {
  const { u } = ctx;
  // Emptiness guard inside the tx (not a pre-read) so two racing
  // seeds can't both pass it: a populated project is a no-op,
  // never a partial double-seed or a version-conflict throw.
  const [docs, cols] = await Promise.all([u.docs.list(1), u.cols.list(1)]);
  if (docs.length > 0 || cols.length > 0) {
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
    const created = await createCollectionCommand(ctx, {
      slug: asCollectionSlug(c.slug),
      name: c.name,
      changedBy,
    });
    changes.push(...created.changes);
  }
  for (const a of EXAMPLE_ATTACHMENTS) {
    const attached = await attachDocumentCommand(ctx, {
      collectionSlug: asCollectionSlug(a.collectionSlug),
      documentSlug: asDocumentSlug(a.documentSlug),
      position: a.position,
      delivery: DEFAULT_COLLECTION_DELIVERY,
      changedBy,
    });
    changes.push(...attached.changes);
  }
  return { result: { seeded: true }, changes };
}
