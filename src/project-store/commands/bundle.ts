import { asCorpusSlug, asDocumentSlug, asFolderSlug } from "../../ids";
import {
  type Bundle,
  BUNDLE_KIND,
  BUNDLE_VERSION,
  bundleMembersOf,
  type BundleSource,
  collectionMembersOf,
  computeRootHash,
  foldersInDependencyOrder,
  type HistoryLine,
  PRODUCT,
  PRODUCT_VERSION,
  sortedBundleFolders,
} from "../../store/domain/bundle";
import { corpusOfRootFolderSlug } from "../../store/domain/corpus-drive";
import { defaultFilename } from "../../store/domain/paths";
import { deriveSearchText } from "../../store/domain/search";
import { collectionVersionSnapshot } from "../../store/domain/versions";
import { compact, DEFAULT_ALWAYS_INCLUDE_BUDGET_TOKENS } from "../../util";
import type { CommandOutcome, ProjectCommandContext } from "../command";
import { corpusSnapshotMembers } from "../command";
import type { ProjectUnit } from "../unit";

import { layOutAsDrivesCommand } from "./drive-layout";

export type ImportBundleCommandResult = Readonly<
  | { ok: true; documents: number; corpora: number }
  | { ok: false; reason: "root-hash-mismatch" }
>;

export async function importBundleCommand(
  ctx: ProjectCommandContext,
  bundle: Bundle,
): Promise<CommandOutcome<ImportBundleCommandResult>> {
  const recomputed = await computeRootHash(bundle.history);
  if (recomputed !== bundle.manifest.integrity.rootHash) {
    return { result: { ok: false, reason: "root-hash-mismatch" }, changes: [] };
  }

  const manifestDocs = new Map(
    bundle.manifest.documents.map((d) => [d.slug, d]),
  );
  for (const [hash, bytes] of Object.entries(bundle.blobs)) {
    await ctx.u.blobs.put(hash, bytes, ctx.now);
  }

  for (const slug of Object.keys(bundle.documents).sort()) {
    const entry = bundle.documents[slug];
    if (entry === undefined) continue;
    const docSlug = asDocumentSlug(slug);
    const node = await ctx.u.docs.put(
      docSlug,
      {
        title: entry.meta.title,
        filename: manifestDocs.get(slug)?.filename ?? defaultFilename(slug),
        contentHash: entry.meta.contentHash,
        docVersion: entry.meta.docVersion,
        updatedAt: entry.meta.updatedAt,
        // Derived, not carried by the bundle — recomputed from the imported
        // head so the reconstructed store is searchable.
        searchText: deriveSearchText(entry.meta.title, entry.md),
      },
      undefined,
    );
    const lines = [...(bundle.history[slug] ?? [])].sort(
      (a, b) => a.docVersion - b.docVersion,
    );
    for (const line of lines) {
      await ctx.u.versions.appendDocumentVersion(
        node.id,
        compact({
          slug: docSlug,
          docVersion: line.docVersion,
          contentHash: line.contentHash,
          prevContentHash: line.prevContentHash,
          changedAt: line.changedAt,
          changedBy: line.changedBy,
          diffSummary: line.diffSummary,
        }),
      );
    }
  }

  for (const f of foldersInDependencyOrder(bundle.manifest.folders)) {
    await ctx.u.folders.importFolder({
      slug: asFolderSlug(f.slug),
      name: f.name,
      createdAt: ctx.now,
      parentSlug: f.parentSlug,
      position: f.position,
    });
  }
  for (const d of [...bundle.manifest.documents].sort((a, b) =>
    a.slug.localeCompare(b.slug),
  )) {
    if (d.folderSlug !== null) {
      await ctx.u.folders.rehomeDocument(
        asDocumentSlug(d.slug),
        asFolderSlug(d.folderSlug),
      );
    }
  }

  // The contract cannot carry an archive flag, so an archived page exports
  // as an ordinary document with no folder. In a drive-shaped bundle (it
  // has corpus roots) every live document sits under a root, so a folderless
  // one can only be such a page: it comes back archived, not as a live
  // document in no corpus. (An older bundle has no roots; there a folderless
  // document is a project-root page, and the layout below puts it in drafts.)
  if (
    bundle.manifest.folders.some(
      (f) => corpusOfRootFolderSlug(f.slug) !== undefined,
    )
  ) {
    for (const d of bundle.manifest.documents) {
      if (d.folderSlug !== null) continue;
      const node = await ctx.u.docs.find(asDocumentSlug(d.slug));
      if (node !== undefined) await ctx.u.docs.archive(node, ctx.now);
    }
  }

  const membership = new Map<string, readonly string[]>();
  for (const slug of Object.keys(bundle.collections).sort()) {
    const colFile = bundle.collections[slug];
    if (colFile === undefined) continue;
    const colSlug = asCorpusSlug(slug);
    const colNode = await ctx.u.cols.createCorpus({
      slug: colSlug,
      name: colFile.name,
      description: colFile.description,
    });
    const members = collectionMembersOf(colFile.members);
    membership.set(
      colSlug,
      members.map((m) => m.documentSlug),
    );
    await ctx.u.versions.appendCollectionVersion(
      colNode.id,
      collectionVersionSnapshot({
        collectionSlug: colSlug,
        collectionVersion: colFile.collectionVersion,
        members,
        changedAt: ctx.now,
        changedBy: "import",
      }),
    );
  }

  // The bundle carries folders and member lists but no corpus → root
  // link, and an older export has documents in several corpora or in
  // none. Land it as drives by the same rule the project migration uses:
  // a bundle exported from a drive-shaped project already has every
  // document under a root folder (recognized by its reserved slug), so
  // this only re-links the roots and the round trip stays byte-identical.
  // The bundle's own snapshots were appended verbatim above and are kept.
  const laidOut = await layOutAsDrivesCommand(ctx, {
    membership,
    snapshot: false,
  });

  return {
    result: {
      ok: true,
      documents: Object.keys(bundle.documents).length,
      corpora: Object.keys(bundle.collections).length,
    },
    changes: laidOut.changes,
  };
}

export async function exportBundleProjection(
  u: ProjectUnit,
  source: BundleSource,
  resolvedViews: ProjectCommandContext["corpus"]["resolvedViews"],
): Promise<Bundle> {
  const heads = [...(await u.docs.listAll())].sort((a, b) =>
    a.slug.localeCompare(b.slug),
  );
  const allDV = await u.versions.allDocumentVersions();

  const folderViews = await u.folders.listAll();
  const folderOf = new Map<string, string | null>();
  for (const h of heads) {
    const f = await u.folders.documentFolder(asDocumentSlug(h.slug));
    folderOf.set(h.slug, f?.slug ?? null);
  }

  const history: Record<string, HistoryLine[]> = {};
  for (const v of allDV) {
    (history[v.slug] ??= []).push(
      compact({
        slug: v.slug,
        docVersion: v.docVersion,
        contentHash: v.contentHash,
        prevContentHash: v.prevContentHash,
        changedAt: v.changedAt,
        changedBy: v.changedBy,
        diffSummary: v.diffSummary,
      }),
    );
  }

  const hashes = new Set<string>();
  for (const v of allDV) hashes.add(v.contentHash);
  for (const h of heads) hashes.add(h.contentHash);
  const blobMap = await u.blobs.getMany([...hashes]);
  const blobs: Record<string, string> = {};
  for (const h of [...hashes].sort()) blobs[h] = blobMap.get(h) ?? "";

  const documents: Bundle["documents"] = {};
  for (const h of heads) {
    documents[h.slug] = {
      md: blobMap.get(h.contentHash) ?? "",
      meta: {
        slug: h.slug,
        title: h.title,
        docVersion: h.docVersion,
        contentHash: h.contentHash,
        updatedAt: h.updatedAt,
      },
    };
  }

  const colMeta = new Map<string, { name: string; description?: string }>();
  for (const c of await u.cols.listAll()) {
    colMeta.set(c.slug, c);
  }
  // Members are always the live tree under the corpus root (the snapshot
  // supplies only the version number), so the bundle can never lag a
  // move. The contract still requires a budget per collection; corpora no
  // longer have one, so the contract's default is written.
  const colRows = await u.versions.latestCollectionVersions();
  const colEntries = await Promise.all(
    colRows.map(async (c) => {
      const meta = colMeta.get(c.collectionSlug);
      const members = corpusSnapshotMembers(
        (await resolvedViews(u, asCorpusSlug(c.collectionSlug))) ?? [],
      );
      return compact({
        slug: c.collectionSlug,
        name: meta?.name ?? c.collectionSlug,
        description: meta?.description,
        alwaysIncludeBudgetTokens: DEFAULT_ALWAYS_INCLUDE_BUDGET_TOKENS,
        collectionVersion: c.collectionVersion,
        members: bundleMembersOf(members),
      });
    }),
  );
  const collections: Bundle["collections"] = {};
  for (const e of colEntries) collections[e.slug] = e;
  const manifestCollections = colEntries.map((e) => ({
    slug: e.slug,
    name: e.name,
    alwaysIncludeBudgetTokens: e.alwaysIncludeBudgetTokens,
    collectionVersion: e.collectionVersion,
    members: e.members,
  }));

  const rootHash = await computeRootHash(history);
  return {
    manifest: {
      kind: BUNDLE_KIND,
      bundleVersion: BUNDLE_VERSION,
      exportedAt: new Date().toISOString(),
      source: {
        product: PRODUCT,
        productVersion: PRODUCT_VERSION,
        organization: source.organization,
        project: source.project,
      },
      documents: heads.map((h) => ({
        slug: h.slug,
        title: h.title,
        docVersion: h.docVersion,
        contentHash: h.contentHash,
        filename: h.filename,
        folderSlug: folderOf.get(h.slug) ?? null,
      })),
      folders: sortedBundleFolders(folderViews),
      collections: manifestCollections,
      integrity: { algorithm: "sha256", rootHash },
    },
    documents,
    collections,
    history,
    blobs,
  };
}
