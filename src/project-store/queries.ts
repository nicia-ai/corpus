import { assembleCollection, type AssembledCollection } from "../corpus";
import {
  asCollectionSlug,
  asDocumentSlug,
  type CollectionSlug,
  type DocumentSlug,
} from "../ids";
import {
  DEFAULT_COLLECTION_DELIVERY,
  expandCollectionDocuments,
  type ExpandEntry,
  type FolderTreeNode,
} from "../store/domain/collection-expand";
import { type ParsedLink, parseLinks } from "../store/domain/links";
import {
  derivePath,
  resolveRelativePath,
  resolveWikiPath,
} from "../store/domain/paths";
import { headSnippet, searchSnippet } from "../store/domain/search";
import {
  type DocumentChain,
  verifyChain,
  type VerifyResult,
} from "../store/domain/verify";
import type {
  CollectionDocView,
  CollectionMeta,
} from "../store/repos/collection-graph";
import { compact, estimateTokens, pluralize } from "../util";

import type {
  CollectionOutline,
  DocumentHistoryEntry,
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

export async function listDocumentsProjection(u: ProjectUnit): Promise<
  readonly {
    slug: string;
    title: string;
    docVersion: number;
    size: number;
    filename: string;
    path: string;
    folderSlug: string | null;
    updatedAt: string;
  }[]
> {
  // Drop archived docs BEFORE bounding, so soft-deleted rows can't consume
  // list slots and silently hide active documents past the limit.
  const docs = (await u.docs.listAll())
    .filter((d) => d.archivedAt === undefined)
    .slice(0, DOC_LIST_LIMIT);
  const [bytes, folders] = await Promise.all([
    u.blobs.getMany(docs.map((d) => d.contentHash)),
    Promise.all(
      docs.map((d) => u.folders.documentFolder(asDocumentSlug(d.slug))),
    ),
  ]);
  const { slugToPath } = await pathIndex(u);
  return docs.map((d, i) => ({
    slug: d.slug,
    title: d.title,
    docVersion: d.docVersion,
    size: estimateTokens(bytes.get(d.contentHash) ?? ""),
    filename: d.filename,
    path: slugToPath.get(d.slug) ?? d.filename,
    folderSlug: folders[i]?.slug ?? null,
    updatedAt: d.updatedAt,
  }));
}

const SEARCH_RESULT_LIMIT = 20;
const SEARCH_MIN_QUERY = 2;

// Case-insensitive substring search over live document HEADS (title +
// body). A bounded in-memory scan, deliberately: a project DO holds at
// most hundreds of documents, drizzle-kit owns all DDL (no hand-rolled
// FTS table), and the blobs are one batched read. Title hits rank ahead
// of body-only hits; each rank orders by path for determinism.
export async function searchDocumentsProjection(
  u: ProjectUnit,
  query: string,
  limit: number = SEARCH_RESULT_LIMIT,
): Promise<readonly DocumentSearchHit[]> {
  const needle = query.trim().toLowerCase();
  if (needle.length < SEARCH_MIN_QUERY) return [];
  const max = Math.max(1, Math.min(limit, SEARCH_RESULT_LIMIT));
  const docs = (await u.docs.listAll()).filter(
    (d) => d.archivedAt === undefined,
  );
  const [bytes, { slugToPath }] = await Promise.all([
    u.blobs.getMany(docs.map((d) => d.contentHash)),
    pathIndex(u),
  ]);
  const titleHits: DocumentSearchHit[] = [];
  const bodyHits: DocumentSearchHit[] = [];
  for (const d of docs) {
    const body = bytes.get(d.contentHash) ?? "";
    const bodyIndex = body.toLowerCase().indexOf(needle);
    const inTitle = d.title.toLowerCase().includes(needle);
    if (!inTitle && bodyIndex === -1) continue;
    // Point the preview at the body match when there is one; a
    // title-only hit previews the body head instead.
    const cut =
      bodyIndex === -1
        ? headSnippet(body)
        : searchSnippet(body, bodyIndex, needle.length);
    const hit: DocumentSearchHit = compact({
      slug: d.slug,
      title: d.title,
      path: slugToPath.get(d.slug) ?? d.filename,
      docVersion: d.docVersion,
      field: inTitle ? ("title" as const) : ("body" as const),
      snippet: cut.snippet,
      matchStart: cut.matchStart,
      matchEnd: cut.matchEnd,
    });
    (inTitle ? titleHits : bodyHits).push(hit);
  }
  const byPath = (a: DocumentSearchHit, b: DocumentSearchHit): number =>
    a.path.localeCompare(b.path);
  titleHits.sort(byPath);
  bodyHits.sort(byPath);
  return [...titleHits, ...bodyHits].slice(0, max);
}

// Every LIVE document as a link-resolution ref (slug + derived path).
// Feeds the editor's broken-link linter and wikilink resolution, which
// need the complete set — a partial/capped list would flag real links as
// broken — and must exclude archived docs (which would otherwise resolve
// as valid targets the documents list doesn't show).
export async function listDocumentRefsProjection(
  u: ProjectUnit,
): Promise<{ slug: string; path: string }[]> {
  const docs = await u.docs.listAll();
  const { slugToPath } = await pathIndex(u);
  return docs
    .filter((d) => d.archivedAt === undefined)
    .map((d) => ({
      slug: d.slug,
      path: slugToPath.get(d.slug) ?? d.filename,
    }));
}

export function listCollectionsProjection(
  u: ProjectUnit,
): Promise<readonly CollectionMeta[]> {
  return u.cols.list(DOC_LIST_LIMIT);
}

export async function usageSnapshotProjection(
  u: ProjectUnit,
): Promise<ProjectUsageSnapshot> {
  const [docs, collections, versions, blobs] = await Promise.all([
    u.docs.list(DOC_LIST_LIMIT),
    u.cols.list(DOC_LIST_LIMIT),
    u.versions.allDocumentVersions(),
    u.blobs.all(),
  ]);
  return {
    activeDocuments: docs.filter((d) => d.archivedAt === undefined).length,
    collections: collections.length,
    documentVersions: versions.length,
    storedMarkdownBytes: blobs.reduce(
      (sum, b) => sum + new TextEncoder().encode(b.bytes).byteLength,
      0,
    ),
  };
}

export async function collectionMetaProjection(
  u: ProjectUnit,
  collectionSlug: CollectionSlug,
): Promise<
  | { found: false }
  | {
      found: true;
      name: string;
      description?: string;
      alwaysIncludeBudgetTokens: number;
    }
> {
  const col = await u.cols.findCollection(collectionSlug);
  if (col === undefined) return { found: false };
  return compact({
    found: true as const,
    name: col.name,
    description: col.description,
    alwaysIncludeBudgetTokens: col.alwaysIncludeBudgetTokens,
  });
}

export async function readCollectionProjection(
  u: ProjectUnit,
  collectionSlug: CollectionSlug,
): Promise<
  | { found: false }
  | ({
      found: true;
      name: string;
      description?: string;
    } & AssembledCollection)
> {
  const colNode = await u.cols.findCollection(collectionSlug);
  const ordered = await resolvedViews(u, collectionSlug);
  if (colNode === undefined || ordered === undefined) {
    return { found: false };
  }
  const delivered = ordered.filter((d) => d.delivery === "core");
  const bytes = await u.blobs.getMany(delivered.map((d) => d.contentHash));
  const documents = delivered.map((d) => ({
    slug: d.slug,
    title: d.title,
    docVersion: d.docVersion,
    updatedAt: d.updatedAt,
    markdown: bytes.get(d.contentHash) ?? "",
  }));
  const assembled: AssembledCollection =
    documents.length === 0 && ordered.length > 0
      ? {
          documents: [],
          corpus: `# Collection: ${collectionSlug}\n(no core guidance documents configured)\n`,
        }
      : assembleCollection(collectionSlug, documents);
  const referenceCount = ordered.length - delivered.length;
  const corpus =
    referenceCount > 0
      ? [
          assembled.corpus,
          "",
          "---",
          referenceCount === 1
            ? `1 reference document is available in collection://${collectionSlug}/outline. Read it with read_document when relevant.`
            : `${pluralize(referenceCount, "reference document")} are available in collection://${collectionSlug}/outline. Read them with read_document when relevant.`,
        ].join("\n")
      : assembled.corpus;
  return {
    found: true,
    ...compact({ name: colNode.name, description: colNode.description }),
    documents: assembled.documents,
    corpus,
  };
}

export async function collectionStructureProjection(
  u: ProjectUnit,
  collectionSlug: CollectionSlug,
): Promise<
  | { found: false }
  | {
      found: true;
      name: string;
      description?: string;
      alwaysIncludeBudgetTokens: number;
      folders: readonly Readonly<{
        slug: string;
        name: string;
        position: number;
        delivery: "core" | "reference";
      }>[];
      members: readonly Readonly<{
        slug: string;
        title: string;
        docVersion: number;
        size: number;
        updatedAt: string;
        direct: boolean;
        position: number;
        delivery: "core" | "reference";
        viaFolder?: string;
      }>[];
    }
> {
  const colNode = await u.cols.findCollection(collectionSlug);
  const entries = await u.cols.entries(collectionSlug);
  const ordered = await resolvedViews(u, collectionSlug);
  if (colNode === undefined || entries === undefined || ordered === undefined) {
    return { found: false };
  }
  const bytes = await u.blobs.getMany(ordered.map((d) => d.contentHash));
  const directSlugs = new Set(entries.documents.map((d) => d.slug));
  const nameBySlug = new Map(
    (await u.folders.listAll()).map((f) => [f.slug, f.name] as const),
  );
  const linkedFolders = [...entries.folders]
    .map((f) => ({
      slug: f.slug,
      name: nameBySlug.get(f.slug) ?? f.slug,
      position: f.position,
      delivery: f.delivery,
    }))
    .sort((a, b) => a.position - b.position);
  const folderDocSlugs = await Promise.all(
    linkedFolders.map(async (f) => {
      const tree = await u.folders.subtree(f.slug);
      const slugs = new Set<string>();
      for (const node of tree.values()) {
        for (const d of node.documents) slugs.add(d.slug);
      }
      return { slug: f.slug, slugs };
    }),
  );
  const members = ordered.map((d) => {
    const direct = directSlugs.has(d.slug);
    const viaFolder = direct
      ? undefined
      : folderDocSlugs.find((f) => f.slugs.has(d.slug))?.slug;
    return compact({
      slug: d.slug,
      title: d.title,
      docVersion: d.docVersion,
      size: estimateTokens(bytes.get(d.contentHash) ?? ""),
      updatedAt: d.updatedAt,
      direct,
      position: d.position,
      delivery: d.delivery,
      viaFolder,
    });
  });
  return compact({
    found: true as const,
    name: colNode.name,
    description: colNode.description,
    alwaysIncludeBudgetTokens: colNode.alwaysIncludeBudgetTokens,
    folders: linkedFolders,
    members,
  });
}

export async function collectionMembersProjection(
  u: ProjectUnit,
  collectionSlug: CollectionSlug,
): Promise<readonly string[] | undefined> {
  const views = await resolvedViews(u, collectionSlug);
  return views?.map((v) => v.slug);
}

// One row per (collection, RESOLVED member document) — direct includes
// plus folder-expanded docs, deduped exactly as the agent-facing
// expansion sees them (shares `resolvedViews`, so a list/card count can
// never disagree with the collection detail or MCP). The single source
// for every "how many documents" / "in how many collections" count.
export async function resolvedMembersProjection(
  u: ProjectUnit,
): Promise<
  readonly Readonly<{ collectionSlug: string; documentSlug: string }>[]
> {
  const collections = await u.cols.list(DOC_LIST_LIMIT);
  const perCollection = await Promise.all(
    collections.map(async (c) => {
      const views = await resolvedViews(u, asCollectionSlug(c.slug));
      return (views ?? []).map((v) => ({
        collectionSlug: c.slug,
        documentSlug: v.slug,
      }));
    }),
  );
  return perCollection.flat();
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

  const collections =
    slug === undefined
      ? (await u.versions.latestCollectionVersions()).map((c) => ({
          collectionSlug: c.collectionSlug,
          collectionVersion: c.collectionVersion,
          members: c.members,
        }))
      : [];

  const blobs = await u.blobs.getMany(rows.map((r) => r.contentHash));
  return verifyChain({ documents, collections, blobs });
}

export async function resolvedViews(
  u: ProjectUnit,
  collectionSlug: CollectionSlug,
): Promise<readonly CollectionDocView[] | undefined> {
  const e = await u.cols.entries(collectionSlug);
  if (e === undefined) return undefined;
  if (e.folders.length === 0) return u.cols.ordered(collectionSlug);

  const tree = new Map<string, FolderTreeNode>();
  for (const sub of await Promise.all(
    e.folders.map((f) => u.folders.subtree(f.slug)),
  )) {
    for (const [k, v] of sub) tree.set(k, v);
  }
  const entries: ExpandEntry[] = [
    ...e.documents.map((d) => ({
      type: "document" as const,
      slug: d.slug,
      position: d.position,
      delivery: d.delivery,
    })),
    ...e.folders.map((f) => ({
      type: "folder" as const,
      slug: f.slug,
      position: f.position,
      delivery: f.delivery,
    })),
  ];
  const expanded = expandCollectionDocuments(entries, tree);
  const nodes = await Promise.all(
    expanded.map((d) => u.docs.find(asDocumentSlug(d.slug))),
  );
  return nodes
    .map((node, i) =>
      node === undefined || node.archivedAt !== undefined
        ? undefined
        : {
            node,
            delivery: expanded[i]?.delivery ?? DEFAULT_COLLECTION_DELIVERY,
          },
    )
    .filter((x) => x !== undefined)
    .map(({ node, delivery }, i) => ({
      slug: node.slug,
      title: node.title,
      docVersion: node.docVersion,
      contentHash: node.contentHash,
      updatedAt: node.updatedAt,
      position: i + 1,
      delivery,
    }));
}

export async function pathIndex(u: ProjectUnit): Promise<
  Readonly<{
    pathToSlug: Map<string, string>;
    slugToPath: Map<string, string>;
  }>
> {
  // Archived docs retain their in_folder edge but must not occupy a path —
  // otherwise a re-upload at the same path collides and relative-link
  // resolution becomes non-deterministic (can resolve to the hidden doc).
  const docs = (await u.docs.listAll()).filter(
    (d) => d.archivedAt === undefined,
  );
  const folders = await Promise.all(
    docs.map((d) => u.folders.documentFolder(asDocumentSlug(d.slug))),
  );
  const namesByFolder = new Map<string, readonly string[]>();
  const pathToSlug = new Map<string, string>();
  const slugToPath = new Map<string, string>();
  for (let i = 0; i < docs.length; i += 1) {
    const d = docs[i];
    if (d === undefined) continue;
    const folder = folders[i];
    let names: readonly string[] = [];
    if (folder != null) {
      names =
        namesByFolder.get(folder.slug) ??
        (await u.folders.ancestorNames(folder));
      namesByFolder.set(folder.slug, names);
    }
    const path = derivePath(names, d.filename);
    pathToSlug.set(path, d.slug);
    slugToPath.set(d.slug, path);
  }
  return { pathToSlug, slugToPath };
}

export async function collectionOutlineProjection(
  u: ProjectUnit,
  collectionSlug: CollectionSlug,
  parsedLinksByHash: Map<string, readonly ParsedLink[]>,
): Promise<CollectionOutline> {
  const colNode = await u.cols.findCollection(collectionSlug);
  const views = await resolvedViews(u, collectionSlug);
  if (colNode === undefined || views === undefined) return { found: false };
  const { pathToSlug, slugToPath } = await pathIndex(u);
  const allPaths = [...pathToSlug.keys()];
  const inCollection = new Set(views.map((v) => v.slug));
  const documents: OutlineDoc[] = [];
  for (const v of views) {
    const path = slugToPath.get(v.slug) ?? v.slug;
    const targets = await parsedLinks(
      parsedLinksByHash,
      v.contentHash,
      async () => (await u.blobs.get(v.contentHash)) ?? "",
    );
    const links: OutlineLink[] = targets.map((link) => {
      const resolved =
        link.kind === "wiki"
          ? resolveWikiPath(path, link.target, allPaths)
          : resolveRelativePath(path, link.target);
      const documentSlug =
        resolved === undefined ? null : (pathToSlug.get(resolved) ?? null);
      return {
        target: link.target,
        kind: link.kind,
        resolvedPath: resolved ?? null,
        documentSlug,
        inCollection: documentSlug !== null && inCollection.has(documentSlug),
      };
    });
    documents.push({
      slug: v.slug,
      path,
      title: v.title,
      docVersion: v.docVersion,
      delivery: v.delivery,
      links,
    });
  }
  return {
    found: true,
    collection: collectionSlug,
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
