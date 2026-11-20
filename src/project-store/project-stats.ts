import {
  corpusRootFolderSlug,
  buildCorpusPathIndex,
  corpusRelativePath,
  resolveCorpusLink,
} from "../store/domain/corpus-drive";
import {
  type ExpandEntry,
  expandCorpusDocuments,
  type FolderTreeNode,
} from "../store/domain/legacy-corpus-shape";
import { type ParsedLink, parseLinks } from "../store/domain/links";
import { derivePath } from "../store/domain/paths";
import {
  computeProjectStats,
  type ProjectStats,
  type StatsCorpus,
  type StatsDocument,
  type StatsLink,
} from "../store/domain/project-stats";

import type { ProjectUnit } from "./unit";

const BLOB_READ_CHUNK = 200;

// Documents that live under no corpus root (a project not yet laid out as
// drives) are resolved together, as the one project-wide tree they still are.
const UNLAID_CORPUS = "";

// Read-only structural snapshot of one Project (counts only — see
// store/domain/project-stats.ts). It describes BOTH shapes, because its job
// includes checking a project before the one-time drive layout runs: a
// document's corpus is whichever root it sits under, and the stored
// pre-drive entries (direct links, folder links, positions, tiers) are read
// from the graph and resolved with the old resolver. It reads the unit it is
// given directly and never triggers the layout migration. Link targets
// resolve like `corpusOutlineProjection`; blobs are read in chunks.
export async function projectStatsProjection(
  u: ProjectUnit,
  parsedLinksByHash: Map<string, readonly ParsedLink[]>,
): Promise<ProjectStats> {
  const [allDocuments, corpusMetas, folders, placed, rootLinks, legacy] =
    await Promise.all([
      u.docs.listAll(),
      u.cols.listAll(),
      u.folders.listAll(),
      u.folders.allDocumentPaths(),
      u.cols.folderLinks(),
      u.cols.legacyEntries(),
    ]);
  const live = allDocuments.filter((d) => d.archivedAt === undefined);
  const liveSlugs = new Set(live.map((d) => d.slug));
  const rootCorpus = new Map(
    rootLinks
      .filter((l) => l.folderSlug === corpusRootFolderSlug(l.corpusSlug))
      .map((l) => [l.folderSlug as string, l.corpusSlug as string]),
  );

  const documents = new Map<string, StatsDocument & { corpusSlug: string }>();
  for (const { path, archived } of placed) {
    if (archived || !liveSlugs.has(path.slug)) continue;
    const rootSlug = path.ancestorSlugs[0];
    const corpusSlug =
      rootSlug === undefined ? undefined : rootCorpus.get(rootSlug);
    const drive = corpusSlug !== undefined && rootSlug !== undefined;
    documents.set(path.slug, {
      slug: path.slug,
      filename: path.filename,
      path: drive
        ? corpusRelativePath(path.ancestorNames, path.filename)
        : derivePath(path.ancestorNames, path.filename),
      folderSlug:
        drive && path.folderSlug === rootSlug ? null : path.folderSlug,
      corpusSlug: corpusSlug ?? UNLAID_CORPUS,
    });
  }
  // A live document with no folder at all (the pre-drive project root).
  for (const d of live) {
    if (!documents.has(d.slug)) {
      documents.set(d.slug, {
        slug: d.slug,
        filename: d.filename,
        path: d.filename,
        folderSlug: null,
        corpusSlug: UNLAID_CORPUS,
      });
    }
  }

  const tree = legacyTree(folders, placed);
  const legacyBySlug = new Map(legacy.map((c) => [c.corpusSlug as string, c]));
  const corpora = corpusMetas.map((meta): StatsCorpus => {
    const entries = legacyBySlug.get(meta.slug);
    const expandEntries: ExpandEntry[] = [
      ...(entries?.documents ?? []).map((e) => ({
        type: "document" as const,
        ...e,
      })),
      ...(entries?.folders ?? []).map((e) => ({
        type: "folder" as const,
        ...e,
      })),
    ];
    const resolved = expandCorpusDocuments(expandEntries, tree).filter((d) =>
      liveSlugs.has(d.slug),
    );
    const taken = new Set(resolved.map((d) => d.slug));
    const underRoot = [...documents.values()]
      .filter((d) => d.corpusSlug === meta.slug && !taken.has(d.slug))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return {
      slug: meta.slug,
      directDocumentSlugs: (entries?.documents ?? []).map((d) => d.slug),
      folderSlugs: (entries?.folders ?? []).map((f) => f.slug),
      members: [
        ...resolved,
        ...underRoot.map((d) => ({ slug: d.slug, delivery: "core" as const })),
      ],
    };
  });

  await warmParsedLinks(
    u,
    parsedLinksByHash,
    live.map((d) => d.contentHash),
  );
  const index = buildCorpusPathIndex(
    [...documents.values()].map((d) => ({
      slug: d.slug,
      path: d.path,
      corpusSlug: d.corpusSlug,
    })),
  );
  const links = live.flatMap((d): StatsLink[] => {
    const source = documents.get(d.slug);
    if (source === undefined) return [];
    return (parsedLinksByHash.get(d.contentHash) ?? []).flatMap((link) => {
      const hit = resolveCorpusLink(source, link, index);
      return hit === undefined
        ? []
        : [{ sourceSlug: d.slug, targetSlug: hit.documentSlug }];
    });
  });

  const roots = new Set(rootCorpus.keys());
  const legacyDirectLinks = legacy.reduce((n, c) => n + c.documents.length, 0);
  const legacyFolderLinks = legacy.reduce((n, c) => n + c.folders.length, 0);
  return computeProjectStats({
    archivedDocuments: allDocuments.length - live.length,
    liveDocuments: [...documents.values()],
    corpora,
    // Roots are hidden: a folder directly under one is top-level.
    folders: folders
      .filter((f) => !roots.has(f.slug))
      .map((f) => ({
        slug: f.slug,
        parentSlug:
          f.parentSlug !== null && roots.has(f.parentSlug)
            ? null
            : f.parentSlug,
      })),
    links,
    layout: {
      corporaWithRoot: corpusMetas.filter((c) =>
        [...rootCorpus.values()].includes(c.slug),
      ).length,
      documentsOutsideRoots: count(
        documents.values(),
        (d) => d.corpusSlug === UNLAID_CORPUS,
      ),
      legacyDirectLinks,
      legacyFolderLinks,
    },
  });
}

function count<T>(items: Iterable<T>, pred: (item: T) => boolean): number {
  let n = 0;
  for (const item of items) if (pred(item)) n += 1;
  return n;
}

// The project tree as plain data for the old resolver's depth-first walk.
function legacyTree(
  folders: Awaited<ReturnType<ProjectUnit["folders"]["listAll"]>>,
  placed: Awaited<ReturnType<ProjectUnit["folders"]["allDocumentPaths"]>>,
): ReadonlyMap<string, FolderTreeNode> {
  return new Map(
    folders.map((f) => [
      f.slug,
      {
        slug: f.slug,
        childFolders: folders
          .filter((c) => c.parentSlug === f.slug)
          .map((c) => ({ slug: c.slug, position: c.position })),
        documents: placed
          .filter((p) => !p.archived && p.path.folderSlug === f.slug)
          .map((p) => ({ slug: p.path.slug, filename: p.path.filename })),
      },
    ]),
  );
}

async function warmParsedLinks(
  u: ProjectUnit,
  cache: Map<string, readonly ParsedLink[]>,
  hashes: readonly string[],
): Promise<void> {
  const missing = [...new Set(hashes)].filter((h) => !cache.has(h));
  for (let i = 0; i < missing.length; i += BLOB_READ_CHUNK) {
    const chunk = missing.slice(i, i + BLOB_READ_CHUNK);
    const bodies = await u.blobs.getMany(chunk);
    for (const hash of chunk) {
      cache.set(hash, parseLinks(bodies.get(hash) ?? ""));
    }
  }
}
