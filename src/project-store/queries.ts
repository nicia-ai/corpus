import { asDocumentSlug, type CorpusSlug, type DocumentSlug } from "../ids";
import {
  buildCorpusPathIndex,
  comparePaths,
  corpusRelativePath,
  resolveCorpusLink,
} from "../store/domain/corpus-drive";
import { type ParsedLink, parseLinks } from "../store/domain/links";
import { toSafeFulltextQuery } from "../store/domain/search";
import {
  type DocumentChain,
  verifyChain,
  type VerifyResult,
} from "../store/domain/verify";
import type { CorpusStore } from "../store/handle";
import type {
  CorpusDocView,
  CorpusMeta,
} from "../store/repos/collection-graph";
import { compact, estimateTokens } from "../util";

import type {
  CorpusFolderView,
  CorpusOutline,
  DocumentHistoryEntry,
  DocumentHistoryMeta,
  DocumentListRow,
  DocumentLocation,
  DocumentRef,
  DocumentSearchHit,
  DocumentSnapshot,
  OutlineDoc,
  OutlineLink,
  ProjectUsageSnapshot,
} from "./contracts";
import type { ProjectUnit } from "./unit";

const DOC_LIST_LIMIT = 500;

export async function getDocumentProjection(
  u: ProjectUnit,
  slug: DocumentSlug,
): Promise<DocumentSnapshot | undefined> {
  const node = await u.docs.find(slug);
  if (node === undefined || node.archivedAt !== undefined) return undefined;
  const markdown = (await u.blobs.get(node.contentHash)) ?? "";
  return {
    slug: node.slug,
    title: node.title,
    filename: node.filename,
    markdown,
    docVersion: node.docVersion,
    updatedAt: node.updatedAt,
  };
}

export async function listDocumentsProjection(
  u: ProjectUnit,
): Promise<readonly DocumentListRow[]> {
  const locations = new Map(
    (await documentLocations(u)).map((l) => [l.slug, l] as const),
  );
  // Drop archived docs BEFORE bounding, so soft-deleted rows can't consume
  // list slots and silently hide active documents past the limit.
  const docs = (await u.docs.listAll())
    .filter((d) => d.archivedAt === undefined)
    .slice(0, DOC_LIST_LIMIT);
  const bytes = await u.blobs.getMany(docs.map((d) => d.contentHash));
  return docs
    .flatMap((d) => {
      const location = locations.get(d.slug);
      return location === undefined
        ? []
        : [
            {
              slug: d.slug,
              title: d.title,
              docVersion: d.docVersion,
              size: estimateTokens(bytes.get(d.contentHash) ?? ""),
              filename: d.filename,
              corpusSlug: location.corpusSlug,
              path: location.path,
              folderSlug: location.folderSlug,
              updatedAt: d.updatedAt,
            },
          ];
    })
    .sort(
      (a, b) =>
        comparePaths(a.corpusSlug, b.corpusSlug) ||
        comparePaths(a.path, b.path),
    );
}

const SEARCH_RESULT_LIMIT = 20;
const SEARCH_MIN_QUERY = 2;

// Full-text search over live document heads, backed by TypeGraph's FTS5
// index on the derived `searchText` field (title + body). Tokenized +
// bm25-ranked, so multi-word queries match non-adjacent terms and results
// come back by relevance, not path order. The query is reduced to safe word
// tokens (`toSafeFulltextQuery`) and run in "plain" mode, so no FTS5 operator
// syntax can inject or throw. Archived docs are excluded because their
// `searchText` is cleared on archive; the `archivedAt` skip is defence in
// depth. Each hit's corpus and path are derived per hit (≤
// SEARCH_RESULT_LIMIT), never over the whole project.
export async function searchDocumentsProjection(
  store: CorpusStore,
  u: ProjectUnit,
  query: string,
): Promise<readonly DocumentSearchHit[]> {
  const needle = toSafeFulltextQuery(query);
  if (needle.length < SEARCH_MIN_QUERY) return [];
  const hits = await store.search.fulltext("Document", {
    query: needle,
    limit: SEARCH_RESULT_LIMIT,
    mode: "plain",
    includeSnippets: true,
    where: (d) => d.archivedAt.isNull(),
  });
  const out: DocumentSearchHit[] = [];
  for (const { node, snippet } of hits) {
    if (node.archivedAt !== undefined) continue;
    const location = await documentLocationProjection(
      u,
      asDocumentSlug(node.slug),
    );
    if (location === undefined) continue;
    out.push({
      slug: node.slug,
      title: node.title,
      corpusSlug: location.corpusSlug,
      path: location.path,
      snippet: snippet ?? "",
    });
  }
  return out;
}

// Where one document lives — its corpus and corpus-relative path — read
// from its own folder chain, without scanning the project. `undefined`
// for a missing or archived document.
export async function documentLocationProjection(
  u: ProjectUnit,
  slug: DocumentSlug,
): Promise<DocumentLocation | undefined> {
  const node = await u.docs.find(slug);
  if (node === undefined || node.archivedAt !== undefined) return undefined;
  const chain = await u.folders.documentFolderChain(slug);
  const [root] = chain;
  const home = chain[chain.length - 1];
  if (root === undefined || home === undefined) return undefined;
  const [corpusSlug] = await u.cols.collectionsIncludingFolders([root.slug]);
  if (corpusSlug === undefined) return undefined;
  return {
    slug: node.slug,
    corpusSlug,
    path: corpusRelativePath(
      chain.map((folder) => folder.name),
      node.filename,
    ),
    folderSlug: home.slug === root.slug ? null : home.slug,
  };
}

// Every LIVE document with the corpus it is in and its path inside that
// corpus. The one place a project path is turned into a corpus-relative
// one, so no surface can show the hidden root folder.
export async function documentLocations(
  u: ProjectUnit,
): Promise<readonly DocumentLocation[]> {
  const [rows, links] = await Promise.all([
    u.folders.liveDocumentPaths(),
    u.cols.folderLinks(),
  ]);
  const corpusOfRoot = new Map(
    links.map((link) => [link.folderSlug as string, link.corpusSlug] as const),
  );
  return rows.flatMap((row) => {
    const rootSlug = row.ancestorSlugs[0];
    const corpusSlug =
      rootSlug === undefined ? undefined : corpusOfRoot.get(rootSlug);
    if (corpusSlug === undefined) return [];
    return [
      {
        slug: row.slug,
        corpusSlug,
        path: corpusRelativePath(row.ancestorNames, row.filename),
        folderSlug: row.folderSlug === rootSlug ? null : row.folderSlug,
      },
    ];
  });
}

// Every LIVE document as a link-resolution ref. Feeds the editor's
// broken-link linter and wikilink resolution, which need the complete set
// — a partial/capped list would flag real links as broken — and must
// exclude archived docs (which would otherwise resolve as valid targets
// the documents list doesn't show).
export async function listDocumentRefsProjection(
  u: ProjectUnit,
): Promise<readonly DocumentRef[]> {
  return (await documentLocations(u)).map((l) => ({
    slug: l.slug,
    path: l.path,
    corpusSlug: l.corpusSlug,
  }));
}

// The folders a person sees: every folder except the corpus roots, each
// tagged with its corpus, a folder directly under a root reported as
// top-level (`parentSlug: null`).
export async function listFoldersProjection(
  u: ProjectUnit,
): Promise<readonly CorpusFolderView[]> {
  const [folders, links] = await Promise.all([
    u.folders.listAll(),
    u.cols.folderLinks(),
  ]);
  const corpusOfRoot = new Map(
    links.map((link) => [link.folderSlug as string, link.corpusSlug] as const),
  );
  const parentOf = new Map(folders.map((f) => [f.slug, f.parentSlug] as const));
  const rootOf = (slug: string): string => {
    let cursor = slug;
    const seen = new Set<string>();
    for (;;) {
      const parent = parentOf.get(cursor) ?? null;
      if (parent === null || seen.has(cursor)) return cursor;
      seen.add(cursor);
      cursor = parent;
    }
  };
  return folders.flatMap((f) => {
    if (f.parentSlug === null) return [];
    const corpusSlug = corpusOfRoot.get(rootOf(f.slug));
    if (corpusSlug === undefined) return [];
    return [
      {
        slug: f.slug,
        name: f.name,
        corpusSlug,
        parentSlug: corpusOfRoot.has(f.parentSlug) ? null : f.parentSlug,
      },
    ];
  });
}

export function listCorporaProjection(
  u: ProjectUnit,
): Promise<readonly CorpusMeta[]> {
  return u.cols.list(DOC_LIST_LIMIT);
}

export async function usageSnapshotProjection(
  u: ProjectUnit,
): Promise<ProjectUsageSnapshot> {
  const [activeDocuments, corpora, documentVersions, blobs] = await Promise.all(
    [
      u.docs.liveCount(),
      u.cols.count(),
      u.versions.totalCount(),
      u.blobs.all(),
    ],
  );
  return {
    activeDocuments,
    corpora,
    documentVersions,
    storedMarkdownBytes: blobs.reduce(
      (sum, b) => sum + new TextEncoder().encode(b.bytes).byteLength,
      0,
    ),
  };
}

export async function corpusMetaProjection(
  u: ProjectUnit,
  corpusSlug: CorpusSlug,
): Promise<
  { found: false } | { found: true; name: string; description?: string }
> {
  const col = await u.cols.findCorpus(corpusSlug);
  if (col === undefined) return { found: false };
  return compact({
    found: true as const,
    name: col.name,
    description: col.description,
  });
}

export async function corpusMembersProjection(
  u: ProjectUnit,
  corpusSlug: CorpusSlug,
): Promise<readonly string[] | undefined> {
  const views = await resolvedViews(u, corpusSlug);
  return views?.map((v) => v.slug);
}

// One row per live document with the corpus it is in. The single source
// for every "how many documents" count.
export async function resolvedMembersProjection(
  u: ProjectUnit,
): Promise<readonly Readonly<{ corpusSlug: string; documentSlug: string }>[]> {
  return (await documentLocations(u)).map((l) => ({
    corpusSlug: l.corpusSlug,
    documentSlug: l.slug,
  }));
}

export async function documentHistoryProjection(
  u: ProjectUnit,
  slug: DocumentSlug,
): Promise<readonly DocumentHistoryEntry[]> {
  const rows = await u.versions.documentVersions(slug);
  const bytes = await u.blobs.getMany(rows.map((r) => r.contentHash));
  return rows
    .map((r) => {
      const body = bytes.get(r.contentHash);
      return compact({
        docVersion: r.docVersion,
        changedAt: r.changedAt,
        changedBy: r.changedBy,
        diffSummary: r.diffSummary,
        markdown: body ?? "",
        retained: body !== undefined,
      });
    })
    .sort((a, b) => b.docVersion - a.docVersion);
}

export async function documentHistoryPageProjection(
  u: ProjectUnit,
  slug: DocumentSlug,
  selectedVersion?: number,
): Promise<
  Readonly<{
    history: readonly DocumentHistoryMeta[];
    active: DocumentHistoryEntry | undefined;
  }>
> {
  const rows = [...(await u.versions.documentVersions(slug))].sort(
    (a, b) => b.docVersion - a.docVersion,
  );
  const retainedHashes = await u.blobs.existing(
    rows.map((row) => row.contentHash),
  );
  const history = rows.map((row) =>
    compact({
      docVersion: row.docVersion,
      changedAt: row.changedAt,
      changedBy: row.changedBy,
      diffSummary: row.diffSummary,
      retained: retainedHashes.has(row.contentHash),
    }),
  );
  const selected =
    selectedVersion === undefined
      ? (rows[1] ?? rows[0])
      : rows.find((row) => row.docVersion === selectedVersion);
  if (selected === undefined) return { history, active: undefined };

  const markdown = retainedHashes.has(selected.contentHash)
    ? await u.blobs.get(selected.contentHash)
    : undefined;
  return {
    history,
    active: compact({
      docVersion: selected.docVersion,
      changedAt: selected.changedAt,
      changedBy: selected.changedBy,
      diffSummary: selected.diffSummary,
      markdown: markdown ?? "",
      retained: markdown !== undefined,
    }),
  };
}

export async function documentHistoryVersionProjection(
  u: ProjectUnit,
  slug: DocumentSlug,
  docVersion: number,
): Promise<DocumentHistoryEntry | undefined> {
  const row = await u.versions.documentVersion(slug, docVersion);
  if (row === undefined) return undefined;
  const markdown = await u.blobs.get(row.contentHash);
  return compact({
    docVersion: row.docVersion,
    changedAt: row.changedAt,
    changedBy: row.changedBy,
    diffSummary: row.diffSummary,
    markdown: markdown ?? "",
    retained: markdown !== undefined,
  });
}

export async function verifyHistoryProjection(
  u: ProjectUnit,
  slug?: DocumentSlug,
): Promise<VerifyResult> {
  const rows =
    slug === undefined
      ? await u.versions.allDocumentVersions()
      : await u.versions.documentVersions(slug);

  const byDoc = new Map<string, DocumentChain["versions"][number][]>();
  for (const r of rows) {
    const list = byDoc.get(r.slug) ?? [];
    list.push({
      docVersion: r.docVersion,
      contentHash: r.contentHash,
      prevContentHash: r.prevContentHash,
    });
    byDoc.set(r.slug, list);
  }
  const documents: DocumentChain[] = [...byDoc.entries()].map(
    ([s, versions]) => ({ slug: s, versions }),
  );

  const corpora =
    slug === undefined
      ? (await u.versions.latestCollectionVersions()).map((c) => ({
          corpusSlug: c.collectionSlug,
          corpusVersion: c.collectionVersion,
          members: c.members,
        }))
      : [];

  const blobs = await u.blobs.getMany(rows.map((r) => r.contentHash));
  return verifyChain({ documents, corpora, blobs });
}

// A corpus's documents: everything under its root, by corpus-relative
// path. `undefined` = no such corpus. Shared by the outline, the member
// scope, the CorpusVersion snapshot and bundle export, so none of them can
// disagree about what a corpus contains or in what order.
export async function resolvedViews(
  u: ProjectUnit,
  corpusSlug: CorpusSlug,
): Promise<readonly CorpusDocView[] | undefined> {
  if ((await u.cols.findCorpus(corpusSlug)) === undefined) return undefined;
  const located = (await documentLocations(u))
    .filter((l) => l.corpusSlug === corpusSlug)
    .sort((a, b) => comparePaths(a.path, b.path));
  const nodes = await u.docs.findMany(
    located.map((l) => asDocumentSlug(l.slug)),
  );
  return located
    .flatMap((location, i) => {
      const node = nodes[i];
      return node === undefined || node.archivedAt !== undefined
        ? []
        : [{ node, path: location.path }];
    })
    .map(({ node, path }, i) => ({
      slug: node.slug,
      path,
      title: node.title,
      docVersion: node.docVersion,
      contentHash: node.contentHash,
      updatedAt: node.updatedAt,
      position: i + 1,
    }));
}

export async function corpusOutlineProjection(
  u: ProjectUnit,
  corpusSlug: CorpusSlug,
  parsedLinksByHash: Map<string, readonly ParsedLink[]>,
): Promise<CorpusOutline> {
  const colNode = await u.cols.findCorpus(corpusSlug);
  const views = await resolvedViews(u, corpusSlug);
  if (colNode === undefined || views === undefined) return { found: false };
  const index = buildCorpusPathIndex(await documentLocations(u));
  const documents: OutlineDoc[] = [];
  for (const v of views) {
    const targets = await parsedLinks(
      parsedLinksByHash,
      v.contentHash,
      async () => (await u.blobs.get(v.contentHash)) ?? "",
    );
    const links: OutlineLink[] = targets.map((link) => {
      const resolved = resolveCorpusLink(
        { corpusSlug, path: v.path },
        link,
        index,
      );
      return {
        target: link.target,
        kind: link.kind,
        resolvedPath: resolved?.path ?? null,
        documentSlug: resolved?.documentSlug ?? null,
        inCorpus: resolved?.corpusSlug === corpusSlug,
      };
    });
    documents.push({
      slug: v.slug,
      path: v.path,
      title: v.title,
      docVersion: v.docVersion,
      links,
    });
  }
  return {
    found: true,
    corpus: corpusSlug,
    name: colNode.name,
    documents,
  };
}

async function parsedLinks(
  cache: Map<string, readonly ParsedLink[]>,
  hash: string,
  loadMarkdown: () => Promise<string>,
): Promise<readonly ParsedLink[]> {
  let v = cache.get(hash);
  if (v === undefined) {
    v = parseLinks(await loadMarkdown());
    cache.set(hash, v);
  }
  return v;
}
