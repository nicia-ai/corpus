import type { CorpusSlug } from "../../ids";
import { asCorpusSlug } from "../../ids";

// The corpus every project has: its drafts space. Loose pages and shared
// pages live here, and a new document lands here when no corpus is named.
// It is NOT served — it cannot be bound to a Connection or API key and is
// never returned to an agent. Moving a page out of it into a named corpus
// is what publishes the page. It cannot be deleted. Routing keys on the
// slug; the name is what people see.
export const DEFAULT_CORPUS_SLUG = asCorpusSlug("default");
export const DEFAULT_CORPUS_NAME = "Drafts";
export const DEFAULT_CORPUS_DESCRIPTION =
  "Unpublished pages. Agents cannot read these until you move them into a corpus.";

export function isDefaultCorpusSlug(slug: CorpusSlug): boolean {
  return slug === DEFAULT_CORPUS_SLUG;
}

// A project written before the default corpus became the drafts space may
// have a Connection or API key bound to it, i.e. it was SERVED. The layout
// migration keeps those pages served by turning them into an ordinary named
// corpus (the default corpus then starts over as an empty drafts space and
// the credentials are re-pointed at the new corpus). The description is the
// marker that lets a retry recognise a corpus an earlier attempt created.
export const PROMOTED_DEFAULT_SLUG = "general";
export const PROMOTED_DEFAULT_NAME = "General";
export const PROMOTED_DEFAULT_DESCRIPTION =
  "The pages this project served from its former default corpus.";
