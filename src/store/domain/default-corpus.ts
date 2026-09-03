import type { CorpusSlug } from "../../ids";
import { asCorpusSlug } from "../../ids";

// The corpus every project materializes on first access. One empty
// bundle so uploads and agent writes have a target without asking the
// user to name a corpus first. Routing keys on slug; the display
// name is user-facing ("Default corpus").
export const DEFAULT_CORPUS_SLUG = asCorpusSlug("default");
export const DEFAULT_CORPUS_NAME = "Default";

export function isDefaultCorpusSlug(slug: CorpusSlug): boolean {
  return slug === DEFAULT_CORPUS_SLUG;
}
