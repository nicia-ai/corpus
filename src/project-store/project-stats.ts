import { asCorpusSlug } from "../ids";
import { type ParsedLink, parseLinks } from "../store/domain/links";
import { resolveRelativePath, resolveWikiPath } from "../store/domain/paths";
import {
  computeProjectStats,
  type ProjectStats,
  type StatsCorpus,
  type StatsLink,
} from "../store/domain/project-stats";

import { pathIndex, resolvedViews } from "./queries";
import type { ProjectUnit } from "./unit";

const BLOB_READ_CHUNK = 200;

// Read-only structural snapshot of one Project (counts only — see
// store/domain/project-stats.ts). Membership is the RESOLVED corpus
// membership via `resolvedViews`, the same resolver every other surface
// uses. Link targets resolve against the current path map exactly like
// `corpusOutlineProjection`; blobs are read in chunks, never per document.
export async function projectStatsProjection(
  u: ProjectUnit,
  parsedLinksByHash: Map<string, readonly ParsedLink[]>,
): Promise<ProjectStats> {
  const [allDocuments, corpusMetas, folders, paths] = await Promise.all([
    u.docs.listAll(),
    u.cols.listAll(),
    u.folders.listAll(),
    pathIndex(u),
  ]);
  const live = allDocuments.filter((d) => d.archivedAt === undefined);

  const corpora = await Promise.all(
    corpusMetas.map(async (meta): Promise<StatsCorpus> => {
      const slug = asCorpusSlug(meta.slug);
      const [entries, views] = await Promise.all([
        u.cols.entries(slug),
        resolvedViews(u, slug),
      ]);
      return {
        slug: meta.slug,
        directDocumentSlugs: (entries?.documents ?? []).map((d) => d.slug),
        folderSlugs: (entries?.folders ?? []).map((f) => f.slug),
        members: (views ?? []).map((v) => ({
          slug: v.slug,
          delivery: v.delivery,
        })),
      };
    }),
  );

  await warmParsedLinks(
    u,
    parsedLinksByHash,
    live.map((d) => d.contentHash),
  );
  const allPaths = [...paths.pathToSlug.keys()];
  const links = live.flatMap((d): StatsLink[] => {
    const sourcePath = paths.slugToPath.get(d.slug) ?? d.filename;
    return (parsedLinksByHash.get(d.contentHash) ?? []).flatMap((link) => {
      const resolved =
        link.kind === "wiki"
          ? resolveWikiPath(sourcePath, link.target, allPaths)
          : resolveRelativePath(sourcePath, link.target);
      const targetSlug =
        resolved === undefined ? undefined : paths.pathToSlug.get(resolved);
      return targetSlug === undefined
        ? []
        : [{ sourceSlug: d.slug, targetSlug }];
    });
  });

  return computeProjectStats({
    archivedDocuments: allDocuments.length - live.length,
    liveDocuments: live.map((d) => ({
      slug: d.slug,
      filename: d.filename,
      path: paths.slugToPath.get(d.slug) ?? d.filename,
      folderSlug: paths.slugToFolderSlug.get(d.slug) ?? null,
    })),
    corpora,
    folders: folders.map((f) => ({ slug: f.slug, parentSlug: f.parentSlug })),
    links,
  });
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
