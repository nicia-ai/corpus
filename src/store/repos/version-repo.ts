import type { Node } from "@nicia-ai/typegraph";

import { InternalError } from "../../errors";
import type { CollectionVersion, DocumentVersion } from "../../graph";
import type { CorpusSlug, DocumentSlug } from "../../ids";
import { planVersionReap } from "../domain/retention";
import type {
  CollectionMember,
  CollectionVersionSnapshot,
  DocumentVersionProps,
} from "../domain/versions";
import type { GraphHandle } from "../handle";

import { findAll } from "./paginate";

export type DocumentVersionNode = Node<typeof DocumentVersion>;
export type CollectionVersionNode = Node<typeof CollectionVersion>;

export type DocumentVersionRow = Readonly<{
  slug: string;
  docVersion: number;
  contentHash: string;
  prevContentHash: string | null;
  changedAt: string;
  changedBy: string;
  diffSummary?: string;
}>;

export type CollectionVersionRow = Readonly<{
  collectionSlug: string;
  collectionVersion: number;
  members: readonly CollectionMember[];
  changedAt: string;
  changedBy: string;
}>;

// All DocumentVersion / CollectionVersion node access (the only version
// store — no relational ledger). The `(slug, docVersion)` /
// `(collectionSlug, collectionVersion)` unique constraints are the
// optimistic-concurrency enforcers; a racing duplicate throws
// TypeGraph's UniquenessError and the enlisted tx rolls back.
export class VersionRepo {
  constructor(private readonly g: GraphHandle) {}

  // Append the immutable version node and link it from its Document.
  async appendDocumentVersion(
    documentNodeId: string,
    props: DocumentVersionProps,
  ): Promise<void> {
    const node = await this.g.nodes.DocumentVersion.create(props);
    await this.g.edges.versions_of.create(
      { kind: "Document", id: documentNodeId },
      { kind: "DocumentVersion", id: node.id },
      {},
    );
  }

  private async findDocumentVersions(
    slug: DocumentSlug,
  ): Promise<DocumentVersionNode[]> {
    return findAll((w) =>
      this.g.nodes.DocumentVersion.find({
        where: (d) => d.slug.eq(slug),
        ...w,
      }),
    );
  }

  versionCount(slug: DocumentSlug): Promise<number> {
    return this.g
      .query()
      .from("DocumentVersion", "v")
      .whereNode("v", (v) => v.slug.eq(slug))
      .count();
  }

  totalCount(): Promise<number> {
    return this.g.query().from("DocumentVersion", "v").count();
  }

  async documentVersions(
    slug: DocumentSlug,
  ): Promise<readonly DocumentVersionRow[]> {
    const nodes = await this.findDocumentVersions(slug);
    return nodes
      .map(toDocumentVersionRow)
      .sort((a, b) => a.docVersion - b.docVersion);
  }

  async documentVersion(
    slug: DocumentSlug,
    docVersion: number,
  ): Promise<DocumentVersionRow | undefined> {
    const nodes = await this.g.nodes.DocumentVersion.find({
      where: (d) => d.slug.eq(slug).and(d.docVersion.eq(docVersion)),
      limit: 1,
    });
    const node = nodes[0];
    return node === undefined ? undefined : toDocumentVersionRow(node);
  }

  async allDocumentVersions(): Promise<readonly DocumentVersionRow[]> {
    const nodes = await findAll((w) => this.g.nodes.DocumentVersion.find(w));
    return nodes
      .map(toDocumentVersionRow)
      .sort(
        (a, b) => a.slug.localeCompare(b.slug) || a.docVersion - b.docVersion,
      );
  }

  // Reap expired versions. Branded node/edge ids never leave the repo:
  // the pure planner decides on opaque ids, the repo maps them back to
  // the original nodes. A hard delete first detaches the `versions_of`
  // edge (TypeGraph forbids hard-deleting a node with connected edges).
  async reapDocumentVersions(
    args: Readonly<{ cutoffIso: string; pinned: ReadonlySet<string> }>,
  ): Promise<{ deleted: number; survivingHashes: readonly string[] }> {
    const nodes = await findAll((w) => this.g.nodes.DocumentVersion.find(w));
    const byId = new Map(nodes.map((n) => [n.id as string, n]));
    const plan = planVersionReap({
      versions: nodes.map((n) => ({
        id: n.id,
        slug: n.slug,
        docVersion: n.docVersion,
        changedAt: n.changedAt,
        contentHash: n.contentHash,
      })),
      cutoffIso: args.cutoffIso,
      pinned: args.pinned,
    });
    const deletions = plan.deleteIds.flatMap((id) => {
      const node = byId.get(id);
      return node === undefined ? [] : [node];
    });
    const edgeGroups = await this.g.edges.versions_of.bulkFindTo(
      deletions.map((node) => ({
        kind: "DocumentVersion" as const,
        id: node.id,
      })),
    );
    for (const [i, node] of deletions.entries()) {
      const edges = edgeGroups[i] ?? [];
      for (const e of edges) await this.g.edges.versions_of.hardDelete(e.id);
      await this.g.nodes.DocumentVersion.hardDelete(node.id);
    }
    return {
      deleted: plan.deleteIds.length,
      survivingHashes: plan.survivingHashes,
    };
  }

  // Append a membership snapshot and link it from its Corpus.
  async appendCollectionVersion(
    corpusNodeId: string,
    snapshot: CollectionVersionSnapshot,
  ): Promise<void> {
    const node = await this.g.nodes.CollectionVersion.create({
      collectionSlug: snapshot.collectionSlug,
      collectionVersion: snapshot.collectionVersion,
      members: JSON.stringify(snapshot.members),
      changedAt: snapshot.changedAt,
      changedBy: snapshot.changedBy,
    });
    await this.g.edges.version_of_collection.create(
      { kind: "Collection", id: corpusNodeId },
      { kind: "CollectionVersion", id: node.id },
      {},
    );
  }

  // Highest collectionVersion for a corpus, or 0 if none yet.
  async latestCollectionVersion(collectionSlug: CorpusSlug): Promise<number> {
    const latest = await this.g
      .query()
      .from("CollectionVersion", "v")
      .whereNode("v", (v) => v.collectionSlug.eq(collectionSlug))
      .orderBy("v", "collectionVersion", "desc")
      .select((ctx) => ctx.v.collectionVersion)
      .first();
    return latest ?? 0;
  }

  // The current membership snapshot per corpus (bundle export, verifier).
  async latestCollectionVersions(): Promise<readonly CollectionVersionRow[]> {
    const rows = await this.g
      .query()
      .from("CollectionVersion", "v")
      .project((e) => ({
        collectionSlug: e.v.collectionSlug,
        collectionVersion: e.v.collectionVersion,
        members: e.v.members,
        changedAt: e.v.changedAt,
        changedBy: e.v.changedBy,
      }))
      .asRelation()
      .topPerPartition({
        partitionBy: (columns) => [columns.collectionSlug],
        orderBy: (columns) => [
          { expression: columns.collectionVersion, direction: "desc" },
          { expression: columns.collectionSlug },
        ],
        limit: 1,
      })
      .orderBy((columns) => columns.collectionSlug)
      .execute();
    return rows.map(toCollectionVersionRow);
  }

  // EVERY membership snapshot, not just the latest per corpus. Retention
  // pins document versions referenced by any live CollectionVersion (not only
  // the head snapshot), so an older snapshot can never be left referencing a
  // reaped version/blob.
  async allCollectionVersions(): Promise<readonly CollectionVersionRow[]> {
    const nodes = await findAll((w) => this.g.nodes.CollectionVersion.find(w));
    return nodes
      .map(toCollectionVersionRow)
      .sort(
        (a, b) =>
          a.collectionSlug.localeCompare(b.collectionSlug) ||
          a.collectionVersion - b.collectionVersion,
      );
  }
}

function toDocumentVersionRow(n: DocumentVersionNode): DocumentVersionRow {
  const base = {
    slug: n.slug,
    docVersion: n.docVersion,
    contentHash: n.contentHash,
    prevContentHash: n.prevContentHash,
    changedAt: n.changedAt,
    changedBy: n.changedBy,
  };
  return n.diffSummary === undefined
    ? base
    : { ...base, diffSummary: n.diffSummary };
}

function toCollectionVersionRow(
  n: Readonly<{
    collectionSlug: string;
    collectionVersion: number;
    members: string;
    changedAt: string;
    changedBy: string;
  }>,
): CollectionVersionRow {
  return {
    collectionSlug: n.collectionSlug,
    collectionVersion: n.collectionVersion,
    members: parseMembers(n.collectionSlug, n.collectionVersion, n.members),
    changedAt: n.changedAt,
    changedBy: n.changedBy,
  };
}

// A corrupt `members` payload on a single row would otherwise throw a
// bare SyntaxError out of every consumer (exportBundle, corpusStructure,
// the chain verifier). Convert to a kinded AppError so the framework
// boundary maps it to a 500 and the row coordinates land in logs.
function parseMembers(
  collectionSlug: string,
  collectionVersion: number,
  raw: string,
): CollectionMember[] {
  try {
    return JSON.parse(raw) as CollectionMember[];
  } catch (err) {
    throw new InternalError(
      `corrupt CollectionVersion(${collectionSlug}@${String(collectionVersion)}).members JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
