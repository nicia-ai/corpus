import { hrefToDocSlug, isExternalHref } from "@/lib/doc-href";
import {
  buildCorpusPathIndex,
  type ResolvedCorpusLink,
  resolveCorpusLink,
} from "@/store/domain/corpus-drive";

import type { WikiResolve } from "./inline-spans";

// A schemeless link target resolved against the project's slugs. Returns the
// warning message when it points nowhere, otherwise undefined. External URLs
// (any scheme, protocol-relative) and in-page anchors are deliberately
// out of scope — we cannot and should not validate those. Reuses the shared
// href helpers (doc-href.ts) so the linter and the link-follower agree on
// what counts as external and how a slug is extracted.
export function classifyInternalRef(
  target: string,
  known: ReadonlyMap<string, string>,
  self: string,
  selfCorpusSlug: string,
  resolvePath?: PathResolve,
): string | undefined {
  const ref = target.trim();
  if (ref === "" || ref.startsWith("#") || isExternalHref(ref))
    return undefined;
  const slug = hrefToDocSlug(ref);
  if (slug === "" || slug === self) return undefined;
  // A relative link names a path (`product.md`, `../docs/a.md`), which is
  // not the same thing as a slug: try it first, so a link to a document in
  // another corpus is recognised whatever that document's slug is.
  const byPath = resolvePath?.(ref);
  if (byPath !== undefined) {
    return selfCorpusSlug === "" || byPath.corpusSlug === selfCorpusSlug
      ? undefined
      : outsideCorpusMessage(slug);
  }
  const corpusSlug = known.get(slug);
  if (corpusSlug === undefined) return `No document “${slug}” in this project`;
  return selfCorpusSlug === "" || corpusSlug === selfCorpusSlug
    ? undefined
    : outsideCorpusMessage(slug);
}

// A link that crosses corpora still resolves on the web, but an agent
// connected to this corpus cannot follow it — worth a warning, never an
// error.
export function outsideCorpusMessage(label: string): string {
  return `“${label}” is in a different corpus — agents connected to this corpus can’t read it`;
}

export type PathResolve = (href: string) => ResolvedCorpusLink | undefined;

// One project document as the link-resolution surface sees it: stable
// slug, the corpus it lives in, and its path relative to that corpus's
// root. The editor derives everything it needs (the linter's known-slug
// set, wikilink resolution) from this one list, so route loaders ship a
// single shape.
export type DocRef = Readonly<{
  slug: string;
  path: string;
  corpusSlug: string;
}>;

// Wikilink target → slug over the project's current doc list, memoized
// per target (the linter and the live-preview decorator both resolve on
// every recompute). Two corpora may both hold `README.md`, so a target
// resolves inside the editing document's own corpus first (same-folder
// ranking keyed off its own path), and only then in the others.
export function wikiResolverFor(
  docRefs: readonly DocRef[],
  selfSlug: string,
  selfCorpusSlug: string,
): WikiResolve | undefined {
  if (docRefs.length === 0) return undefined;
  const index = buildCorpusPathIndex(docRefs);
  const self = docRefs.find((d) => d.slug === selfSlug);
  const source = {
    corpusSlug: self?.corpusSlug ?? selfCorpusSlug,
    path: self?.path ?? "",
  };
  const memo = new Map<string, string | undefined>();
  return (target: string): string | undefined => {
    if (memo.has(target)) return memo.get(target);
    const slug = resolveCorpusLink(
      source,
      { kind: "wiki", target },
      index,
    )?.documentSlug;
    memo.set(target, slug);
    return slug;
  };
}

// A markdown link's relative target → the document it names, resolved from
// the editing document's own path inside its own corpus first (the same rule
// the corpus outline applies). `undefined` when no document sits at that
// path in any corpus.
export function pathResolverFor(
  docRefs: readonly DocRef[],
  selfSlug: string,
  selfCorpusSlug: string,
): PathResolve {
  const index = buildCorpusPathIndex(docRefs);
  const self = docRefs.find((d) => d.slug === selfSlug);
  const source = {
    corpusSlug: self?.corpusSlug ?? selfCorpusSlug,
    path: self?.path ?? "",
  };
  return (href) => {
    const target = href.replace(/[?#].*$/u, "");
    return target === ""
      ? undefined
      : resolveCorpusLink(source, { kind: "path", target }, index);
  };
}
