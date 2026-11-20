import type { CollectionDelivery } from "./collection-delivery";
import { DEFAULT_CORPUS_SLUG } from "./default-corpus";

// Pure, zero-IO structural aggregation over one Project. Counts only:
// the output never carries a title, slug, path, name or user id, so a
// snapshot is safe to store in the control plane and read by an operator.
// Unit-tested over a hand-built fixture (test/project-stats.test.ts).

// Bump when a field's meaning or presence changes; stored beside the JSON.
export const PROJECT_STATS_SCHEMA_VERSION = 2;

export type StatsDocument = Readonly<{
  slug: string;
  filename: string;
  path: string;
  folderSlug: string | null;
}>;

export type StatsCorpus = Readonly<{
  slug: string;
  directDocumentSlugs: readonly string[];
  folderSlugs: readonly string[];
  // RESOLVED membership in delivery order (direct + folder, deduped).
  members: readonly Readonly<{ slug: string; delivery: CollectionDelivery }>[];
}>;

export type StatsFolder = Readonly<{
  slug: string;
  parentSlug: string | null;
}>;

export type StatsLink = Readonly<{ sourceSlug: string; targetSlug: string }>;

// How far the project is from the drive layout (every corpus has a root, every
// document sits under one, no pre-drive links remain). All zero except
// `corporaWithRoot` (= corpora) once it has been laid out.
export type StatsLayout = Readonly<{
  corporaWithRoot: number;
  documentsOutsideRoots: number;
  legacyDirectLinks: number;
  legacyFolderLinks: number;
}>;

export type ProjectStatsInput = Readonly<{
  archivedDocuments: number;
  liveDocuments: readonly StatsDocument[];
  corpora: readonly StatsCorpus[];
  folders: readonly StatsFolder[];
  links: readonly StatsLink[];
  layout: StatsLayout;
}>;

export type CorpusStats = Readonly<{
  members: number;
  distinctTopLevelFolders: number;
  distinctParentFolders: number;
  membersAtRoot: number;
  coreMembers: number;
  referenceMembers: number;
  orderDiffersFromLexicalPath: boolean;
}>;

export type ProjectStats = Readonly<{
  documents: Readonly<{
    total: number;
    live: number;
    archived: number;
    inNoCorpus: number;
    inOneCorpus: number;
    inTwoOrMoreCorpora: number;
  }>;
  corpora: Readonly<{
    total: number;
    withDirectDocuments: number;
    withFolderInclusions: number;
    withBothInclusionKinds: number;
    withDocumentViaBoth: number;
    defaultPresent: boolean;
    defaultMembers: number;
    maxMembers: number;
    totalMembers: number;
  }>;
  perCorpus: readonly CorpusStats[];
  folders: Readonly<{
    total: number;
    maxDepth: number;
    topLevel: number;
    includedByTwoOrMoreCorpora: number;
  }>;
  sameFilenamePairsAcrossCorpora: number;
  layout: StatsLayout;
  links: Readonly<{
    resolved: number;
    crossCorpus: number;
  }>;
}>;

function count<T>(items: Iterable<T>, pred: (item: T) => boolean): number {
  let n = 0;
  for (const item of items) if (pred(item)) n += 1;
  return n;
}

// Folder-tree geometry from the parent map. Cycle-guarded defensively
// (the single-parent invariant forbids cycles; a stats job must not hang).
function folderGeometry(folders: readonly StatsFolder[]) {
  const parentOf = new Map(folders.map((f) => [f.slug, f.parentSlug]));
  const chain = (slug: string): readonly string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    let cursor: string | null | undefined = slug;
    while (cursor != null && !seen.has(cursor) && parentOf.has(cursor)) {
      seen.add(cursor);
      out.push(cursor);
      cursor = parentOf.get(cursor);
    }
    return out; // nearest-first; last element is the top-level folder
  };
  return {
    depth: (slug: string): number => chain(slug).length,
    topLevelOf: (slug: string): string | undefined => chain(slug).at(-1),
    ancestorsAndSelf: chain,
  };
}

function isLexicallyOrdered(paths: readonly string[]): boolean {
  return paths.every((p, i) => i === 0 || (paths[i - 1] ?? "") <= p);
}

export function computeProjectStats(input: ProjectStatsInput): ProjectStats {
  const geometry = folderGeometry(input.folders);
  const docBySlug = new Map(input.liveDocuments.map((d) => [d.slug, d]));
  // Sorted by slug so indices are stable between runs without exposing it.
  const corpora = [...input.corpora].sort((a, b) =>
    a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0,
  );

  const corporaOf = new Map<string, Set<string>>();
  for (const c of corpora) {
    for (const m of c.members) {
      const set = corporaOf.get(m.slug) ?? new Set<string>();
      set.add(c.slug);
      corporaOf.set(m.slug, set);
    }
  }
  const membershipOf = (slug: string): number => corporaOf.get(slug)?.size ?? 0;

  const folderReachable = (c: StatsCorpus, doc: StatsDocument): boolean =>
    doc.folderSlug !== null &&
    geometry
      .ancestorsAndSelf(doc.folderSlug)
      .some((f) => c.folderSlugs.includes(f));

  const hasLiveDirect = (c: StatsCorpus): boolean =>
    c.directDocumentSlugs.some((s) => docBySlug.has(s));
  const hasDocumentViaBoth = (c: StatsCorpus): boolean =>
    c.directDocumentSlugs.some((s) => {
      const doc = docBySlug.get(s);
      return doc !== undefined && folderReachable(c, doc);
    });

  const defaultCorpus = corpora.find((c) => c.slug === DEFAULT_CORPUS_SLUG);
  const memberCounts = corpora.map((c) => c.members.length);

  const corpusInclusionsOfFolder = new Map<string, number>();
  for (const c of corpora) {
    for (const f of new Set(c.folderSlugs)) {
      corpusInclusionsOfFolder.set(
        f,
        (corpusInclusionsOfFolder.get(f) ?? 0) + 1,
      );
    }
  }

  const perCorpus = corpora.map((c): CorpusStats => {
    const docs = c.members.flatMap((m) => {
      const d = docBySlug.get(m.slug);
      return d === undefined ? [] : [d];
    });
    const homed = docs.flatMap((d) => (d.folderSlug === null ? [] : [d]));
    const coreMembers = count(c.members, (m) => m.delivery === "core");
    return {
      members: c.members.length,
      distinctTopLevelFolders: new Set(
        homed.flatMap((d) => geometry.topLevelOf(d.folderSlug ?? "") ?? []),
      ).size,
      distinctParentFolders: new Set(homed.map((d) => d.folderSlug)).size,
      membersAtRoot: docs.length - homed.length,
      coreMembers,
      referenceMembers: c.members.length - coreMembers,
      orderDiffersFromLexicalPath: !isLexicallyOrdered(docs.map((d) => d.path)),
    };
  });

  const byFilename = new Map<string, string[]>();
  for (const d of input.liveDocuments) {
    byFilename.set(d.filename, [...(byFilename.get(d.filename) ?? []), d.slug]);
  }
  let sameFilenamePairs = 0;
  for (const slugs of byFilename.values()) {
    for (let i = 0; i < slugs.length; i += 1) {
      for (let j = i + 1; j < slugs.length; j += 1) {
        const a = corporaOf.get(slugs[i] ?? "") ?? new Set<string>();
        const b = corporaOf.get(slugs[j] ?? "") ?? new Set<string>();
        const onlySameCorpus =
          a.size === 1 && b.size === 1 && [...a][0] === [...b][0];
        if (a.size > 0 && b.size > 0 && !onlySameCorpus) sameFilenamePairs += 1;
      }
    }
  }

  const resolvedLinks = input.links.filter(
    (l) => l.sourceSlug !== l.targetSlug,
  );
  const crossCorpus = count(resolvedLinks, (l) => {
    const s = corporaOf.get(l.sourceSlug);
    const t = corporaOf.get(l.targetSlug);
    return (
      s !== undefined &&
      t !== undefined &&
      ![...s].some((corpus) => t.has(corpus))
    );
  });

  const folderDepths = input.folders.map((f) => geometry.depth(f.slug));
  const live = input.liveDocuments.length;
  const inNoCorpus = count(
    input.liveDocuments,
    (d) => membershipOf(d.slug) === 0,
  );
  const inOne = count(input.liveDocuments, (d) => membershipOf(d.slug) === 1);

  return {
    documents: {
      total: live + input.archivedDocuments,
      live,
      archived: input.archivedDocuments,
      inNoCorpus,
      inOneCorpus: inOne,
      inTwoOrMoreCorpora: live - inNoCorpus - inOne,
    },
    corpora: {
      total: corpora.length,
      withDirectDocuments: count(corpora, hasLiveDirect),
      withFolderInclusions: count(corpora, (c) => c.folderSlugs.length > 0),
      withBothInclusionKinds: count(
        corpora,
        (c) => hasLiveDirect(c) && c.folderSlugs.length > 0,
      ),
      withDocumentViaBoth: count(corpora, hasDocumentViaBoth),
      defaultPresent: defaultCorpus !== undefined,
      defaultMembers: defaultCorpus?.members.length ?? 0,
      maxMembers: memberCounts.reduce((max, n) => Math.max(max, n), 0),
      totalMembers: memberCounts.reduce((sum, n) => sum + n, 0),
    },
    perCorpus,
    folders: {
      total: input.folders.length,
      maxDepth: folderDepths.reduce((max, n) => Math.max(max, n), 0),
      topLevel: count(input.folders, (f) => f.parentSlug === null),
      includedByTwoOrMoreCorpora: count(
        corpusInclusionsOfFolder.values(),
        (n) => n >= 2,
      ),
    },
    sameFilenamePairsAcrossCorpora: sameFilenamePairs,
    layout: input.layout,
    links: { resolved: resolvedLinks.length, crossCorpus },
  };
}
