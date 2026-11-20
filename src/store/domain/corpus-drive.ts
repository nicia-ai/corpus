import {
  asCorpusSlug,
  asFolderSlug,
  type CorpusSlug,
  type FolderSlug,
} from "../../ids";

import { isDefaultCorpusSlug } from "./default-corpus";
import type { LinkKind } from "./links";
import { derivePath, resolveRelativePath, resolveWikiPath } from "./paths";

// The corpus-as-drive rules, pure and zero-IO. A corpus owns exactly one
// hidden top-level folder (its root); a document is in a corpus exactly
// when it lives under that root. Every user-facing path is relative to
// the root, so the root's own name never appears in one.

// `:` cannot be produced by `slugifyToken`, so no user-created folder can
// ever claim a root's slug. The bundle contract has no corpus→root link;
// this reserved slug is how a root folder is recognized on import.
const CORPUS_ROOT_FOLDER_SLUG_PREFIX = "corpus-root:";

export function corpusRootFolderSlug(corpusSlug: CorpusSlug): FolderSlug {
  return asFolderSlug(`${CORPUS_ROOT_FOLDER_SLUG_PREFIX}${corpusSlug}`);
}

export function corpusOfRootFolderSlug(
  folderSlug: string,
): CorpusSlug | undefined {
  return folderSlug.startsWith(CORPUS_ROOT_FOLDER_SLUG_PREFIX)
    ? asCorpusSlug(folderSlug.slice(CORPUS_ROOT_FOLDER_SLUG_PREFIX.length))
    : undefined;
}

// A place inside one corpus: a folder of it, or (null) its root.
export type CorpusLocation = Readonly<{
  corpusSlug: CorpusSlug;
  folderSlug: FolderSlug | null;
}>;

// The default corpus is the drafts space: its pages are never served to
// an agent. Being served is nothing more than living in a named corpus.
export function corpusIsServed(corpusSlug: CorpusSlug): boolean {
  return !isDefaultCorpusSlug(corpusSlug);
}

// `ancestorFolderNames` runs root → leaf and starts with the corpus root.
export function corpusRelativePath(
  ancestorFolderNames: readonly string[],
  filename: string,
): string {
  return derivePath(ancestorFolderNames.slice(1), filename);
}

// Listing order everywhere: by corpus-relative path, code-unit order (the
// order a plain `sort` of the path strings gives), so it is identical on
// every surface and independent of locale.
export function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export type CorpusDocumentRef = Readonly<{
  slug: string;
  path: string;
  corpusSlug: string;
}>;

export type CorpusPathIndex = ReadonlyMap<string, ReadonlyMap<string, string>>;

export function buildCorpusPathIndex(
  refs: readonly CorpusDocumentRef[],
): CorpusPathIndex {
  const index = new Map<string, Map<string, string>>();
  for (const ref of refs) {
    const paths = index.get(ref.corpusSlug) ?? new Map<string, string>();
    paths.set(ref.path, ref.slug);
    index.set(ref.corpusSlug, paths);
  }
  return index;
}

export type ResolvedCorpusLink = Readonly<{
  corpusSlug: string;
  path: string;
  documentSlug: string;
}>;

type LinkTarget = Readonly<{ kind: LinkKind; target: string }>;

function resolveWithin(
  corpusSlug: string,
  sourcePath: string,
  link: LinkTarget,
  index: CorpusPathIndex,
): ResolvedCorpusLink | undefined {
  const paths = index.get(corpusSlug);
  if (paths === undefined) return undefined;
  const path =
    link.kind === "wiki"
      ? resolveWikiPath(sourcePath, link.target, [...paths.keys()])
      : resolveRelativePath(sourcePath, link.target);
  const documentSlug = path === undefined ? undefined : paths.get(path);
  return path === undefined || documentSlug === undefined
    ? undefined
    : { corpusSlug, path, documentSlug };
}

// Two corpora may hold the same relative path (both have `README.md`), so
// a link resolves inside the source document's own corpus first. Only when
// nothing matches there does it fall through to the other corpora, in slug
// order, where the same relative path (or wikilink name) is tried from
// each root — a link that crosses corpora keeps resolving, and the linter
// reports it as outside the corpus.
export function resolveCorpusLink(
  source: Readonly<{ corpusSlug: string; path: string }>,
  link: LinkTarget,
  index: CorpusPathIndex,
): ResolvedCorpusLink | undefined {
  const own = resolveWithin(source.corpusSlug, source.path, link, index);
  if (own !== undefined) return own;
  const others = [...index.keys()]
    .filter((slug) => slug !== source.corpusSlug)
    .sort(comparePaths);
  for (const corpusSlug of others) {
    const hit = resolveWithin(corpusSlug, source.path, link, index);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

// — Laying an existing project out as drives ————————————————————————
//
// The one rule that turns the old shape (one project-wide tree, corpora as
// selections over it) into drives. Shared by the per-project migration and
// by bundle import, so an old export lands exactly where the migration
// would have put it.

export type LayoutCorpus = Readonly<{ slug: string; createdAt: string }>;

export type LayoutDocument = Readonly<{
  slug: string;
  // Folder names from the project root down to the document's folder.
  folderNames: readonly string[];
  // The corpus whose root this document already lives under, if any.
  homeCorpusSlug: string | undefined;
  // Every corpus that resolved this document in the old shape.
  memberOf: readonly string[];
}>;

export type LayoutPlacement = Readonly<{
  documentSlug: string;
  corpusSlug: string;
  // Folders to recreate under the corpus root, so the document keeps its
  // existing project path as its corpus-relative path.
  folderNames: readonly string[];
}>;

export type LayoutConflict = Readonly<{
  documentSlug: string;
  keptIn: string;
  droppedFrom: readonly string[];
}>;

export type LayoutPlan = Readonly<{
  placements: readonly LayoutPlacement[];
  conflicts: readonly LayoutConflict[];
}>;

// Earliest-created first; ties broken by slug.
export function byCreation(a: LayoutCorpus, b: LayoutCorpus): number {
  return comparePaths(a.createdAt, b.createdAt) || comparePaths(a.slug, b.slug);
}

// A document already under a corpus root stays put. Any other goes to the
// earliest-created corpus that resolved it (ties broken by slug), or to
// the default corpus when none did, at its existing project path.
export function planDriveLayout(
  input: Readonly<{
    corpora: readonly LayoutCorpus[];
    defaultCorpusSlug: string;
    documents: readonly LayoutDocument[];
  }>,
): LayoutPlan {
  const creationRank = new Map(
    [...input.corpora].sort(byCreation).map((c, rank) => [c.slug, rank]),
  );
  const placements: LayoutPlacement[] = [];
  const conflicts: LayoutConflict[] = [];
  for (const doc of input.documents) {
    if (doc.homeCorpusSlug !== undefined) continue;
    const owners = [...new Set(doc.memberOf)]
      .filter((slug) => creationRank.has(slug))
      .sort((a, b) => (creationRank.get(a) ?? 0) - (creationRank.get(b) ?? 0));
    const [keptIn = input.defaultCorpusSlug, ...droppedFrom] = owners;
    placements.push({
      documentSlug: doc.slug,
      corpusSlug: keptIn,
      folderNames: doc.folderNames,
    });
    if (droppedFrom.length > 0) {
      conflicts.push({ documentSlug: doc.slug, keptIn, droppedFrom });
    }
  }
  return { placements, conflicts };
}
