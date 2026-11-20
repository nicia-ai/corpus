import { asCorpusSlug, asDocumentSlug } from "../../ids";
import { EXAMPLE_COLLECTIONS, EXAMPLE_DOCS } from "../../sample-project";
import { isDefaultCorpusSlug } from "../../store/domain/default-corpus";
import type { DomainChange, ProjectCommandContext } from "../command";
import type { SeedResult } from "../contracts";

import { createCorpusCommand } from "./corpora";
import { corpusTreeChanged, ensureCorpusRoot } from "./corpus-tree";
import { saveDocumentCommand } from "./documents";

// Seedable = nothing in it yet: no document, and no corpus other than the
// (necessarily empty, since there is no document) default one.
async function projectIsSeedable(ctx: ProjectCommandContext): Promise<boolean> {
  const { u } = ctx;
  const [docs, cols] = await Promise.all([u.docs.list(1), u.cols.list(2)]);
  if (docs.length > 0) return false;
  return cols.every((c) => isDefaultCorpusSlug(asCorpusSlug(c.slug)));
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
  for (const c of EXAMPLE_COLLECTIONS) {
    const corpusSlug = asCorpusSlug(c.slug);
    const created = await createCorpusCommand(ctx, {
      slug: corpusSlug,
      name: c.name,
      description: c.description,
      changedBy,
    });
    changes.push(...created.changes);
    const rootSlug = await ensureCorpusRoot(ctx, corpusSlug);
    for (const d of EXAMPLE_DOCS.filter((doc) => doc.corpusSlug === c.slug)) {
      const saved = await saveDocumentCommand(ctx, {
        slug: asDocumentSlug(d.slug),
        title: d.title,
        markdown: d.markdown,
        ...(rootSlug === undefined ? {} : { folderSlug: rootSlug }),
        clientVersion: 0,
        changedBy,
      });
      changes.push(...saved.changes);
    }
    changes.push(
      ...(await corpusTreeChanged(ctx, [corpusSlug], changedBy, "membership")),
    );
  }
  return { result: { seeded: true }, changes };
}
