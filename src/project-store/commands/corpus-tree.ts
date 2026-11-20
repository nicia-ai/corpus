import {
  asDocumentSlug,
  type CorpusSlug,
  type DocumentSlug,
  type FolderSlug,
} from "../../ids";
import {
  collectionFolderTreeChanged,
  type CollectionChange,
} from "../../store/domain/change-events";
import {
  type CorpusLocation,
  corpusRootFolderSlug,
} from "../../store/domain/corpus-drive";
import type { ProjectCommandContext } from "../command";
import type { ProjectUnit } from "../unit";

// Every corpus owns exactly one hidden top-level folder — its root — and a
// document is in the corpus exactly when it lives under it. These helpers
// are the only way a command turns "a corpus" or "a place in a corpus"
// into a folder, so no write can land outside a root.

// Idempotent: creates and links the root on first use, adopts an existing
// root folder that is not linked yet (a bundle carries the folder but not
// the link). `undefined` = no such corpus.
export async function ensureCorpusRoot(
  ctx: ProjectCommandContext,
  corpusSlug: CorpusSlug,
): Promise<FolderSlug | undefined> {
  const corpus = await ctx.u.cols.findCorpus(corpusSlug);
  if (corpus === undefined) return undefined;
  const linked = await ctx.u.cols.rootFolderSlug(corpusSlug);
  if (linked !== undefined) return linked;
  const slug = corpusRootFolderSlug(corpusSlug);
  const folder =
    (await ctx.u.folders.find(slug)) ??
    (await ctx.u.folders.createRoot({
      slug,
      name: corpusSlug,
      createdAt: ctx.now,
    }));
  await ctx.u.cols.linkRoot(corpus, folder);
  return slug;
}

export async function corpusOfFolder(
  u: ProjectUnit,
  folderSlug: FolderSlug,
): Promise<CorpusSlug | undefined> {
  const [root] = await u.folders.folderChain(folderSlug);
  if (root === undefined) return undefined;
  const [corpusSlug] = await u.cols.collectionsIncludingFolders([root.slug]);
  return corpusSlug;
}

export async function corpusOfDocument(
  u: ProjectUnit,
  documentSlug: DocumentSlug,
): Promise<CorpusSlug | undefined> {
  const [root] = await u.folders.documentFolderChain(documentSlug);
  if (root === undefined) return undefined;
  const [corpusSlug] = await u.cols.collectionsIncludingFolders([root.slug]);
  return corpusSlug;
}

// Where EVERY document is, in two statements however many there are: slug →
// the corpus it is in. The set read for a bulk move; a single document asks
// `corpusOfDocument`.
export async function corpusOfEveryDocument(
  u: ProjectUnit,
): Promise<ReadonlyMap<DocumentSlug, CorpusSlug>> {
  const [paths, links] = await Promise.all([
    u.folders.allDocumentPaths(),
    u.cols.folderLinks(),
  ]);
  const corpusOfRoot = new Map(
    links.map((link) => [link.folderSlug as string, link.corpusSlug] as const),
  );
  return new Map(
    paths.flatMap(({ path }) => {
      const rootSlug = path.ancestorSlugs[0];
      const corpusSlug =
        rootSlug === undefined ? undefined : corpusOfRoot.get(rootSlug);
      return corpusSlug === undefined
        ? []
        : [[asDocumentSlug(path.slug), corpusSlug] as const];
    }),
  );
}

// A corpus root is never addressable by slug: people cannot see, rename,
// move or delete it. Top-level is what makes a folder a root.
export async function isCorpusRoot(
  u: ProjectUnit,
  folderSlug: FolderSlug,
): Promise<boolean> {
  return (await u.folders.folderChain(folderSlug)).length === 1;
}

// The folder a location names: the corpus root for `folderSlug: null`,
// else that folder — but only when it really is inside that corpus.
// `undefined` = the corpus or folder does not exist, or the folder
// belongs to a different corpus.
export async function resolveCorpusFolder(
  u: ProjectUnit,
  location: CorpusLocation,
): Promise<FolderSlug | undefined> {
  const root = await u.cols.rootFolderSlug(location.corpusSlug);
  if (root === undefined) return undefined;
  if (location.folderSlug === null) return root;
  if (location.folderSlug === root) return undefined;
  return (await corpusOfFolder(u, location.folderSlug)) === location.corpusSlug
    ? location.folderSlug
    : undefined;
}

// The live documents under a folder, at any depth — what travels when the
// folder moves.
export async function liveDocumentsUnder(
  ctx: ProjectCommandContext,
  folderSlug: FolderSlug,
): Promise<readonly DocumentSlug[]> {
  const subtree = await ctx.u.folders.subtree(folderSlug);
  const slugs = [...subtree.values()].flatMap((folder) =>
    folder.documents.map((d) => asDocumentSlug(d.slug)),
  );
  const nodes = await ctx.u.docs.findMany(slugs);
  return slugs.filter((_, i) => {
    const node = nodes[i];
    return node !== undefined && node.archivedAt === undefined;
  });
}

// What changed inside a corpus's tree. `paths` = documents were renamed or
// rearranged but the document set is the same: an audit event ("reorganized")
// is the only trace. `membership` = documents joined or left (created,
// archived, moved across corpora): the corpus gets a fresh CorpusVersion
// snapshot, and NO tree event — the document's own created / archived /
// moved-in / moved-out events already say what happened, and a second
// "reordered" row per document create would drown the activity log.
export type CorpusTreeChange = "paths" | "membership";

export async function corpusTreeChanged(
  ctx: ProjectCommandContext,
  corpusSlugs: readonly CorpusSlug[],
  changedBy: string,
  change: CorpusTreeChange,
): Promise<readonly CollectionChange[]> {
  const out: CollectionChange[] = [];
  for (const corpusSlug of new Set(corpusSlugs)) {
    if (change === "membership") {
      await ctx.corpus.snapshot(ctx.u, corpusSlug, changedBy, ctx.now);
      continue;
    }
    out.push(
      collectionFolderTreeChanged({
        corpusSlug,
        changedBy,
        changedAt: ctx.now,
      }),
    );
  }
  return out;
}
