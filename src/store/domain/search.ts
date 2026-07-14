// Pure, zero-IO helpers for full-text search.
//
// Search runs on TypeGraph's FTS5 index, not an in-memory scan. The body
// markdown lives in the content-addressed blob ledger, so it cannot be
// indexed directly — instead each Document node carries a DERIVED
// `searchText` (title + current body) that FTS5 tokenizes. It is recomputed
// on every head change, never canonical (the blob is), and never part of the
// bundle. FTS5's tokenizer splits on markdown punctuation, so the raw body
// needs no stripping.

// The head text a document contributes to the fulltext index: its title
// followed by the current markdown body.
export function deriveSearchText(title: string, markdown: string): string {
  return `${title}\n${markdown}`;
}

// Reduce a raw user query to whitespace-separated word tokens, dropping every
// character an FTS5 / tsquery parser would treat as an operator (quotes, `*`,
// `+`, `-`, `^`, `:`, parentheses, `NEAR(`…). The result is safe to hand to
// `store.search.fulltext` in "plain" mode — terms are ANDed, and no input can
// inject query syntax or throw a parse error. Returns "" when nothing
// searchable remains (an all-punctuation query), which callers treat as
// "no results".
export function toSafeFulltextQuery(raw: string): string {
  return raw
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}
