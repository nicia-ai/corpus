import type { CollectionSlug, DocumentSlug } from "../../ids";
import { compact } from "../../util";

import type { CollectionDelivery } from "./collection-expand";

// Pure constructors for the version-model nodes — the single place the
// genesis rule (`prevContentHash === null` at v1) and the
// member-snapshot shape are expressed. Zero-IO, unit-tested without a DO.

// The composite key identifying one document version (`<slug> <n>`).
// Retention pinning and the verifier's member-resolution map both key on
// this; it MUST be one format, so it has exactly one constructor.
export function versionKey(slug: string, docVersion: number): string {
  return `${slug} ${String(docVersion)}`;
}

export type DocumentVersionProps = Readonly<{
  slug: DocumentSlug;
  docVersion: number;
  contentHash: string;
  prevContentHash: string | null;
  changedAt: string;
  changedBy: string;
  diffSummary?: string;
}>;

// One resolved, position-ordered member of a collection snapshot, each
// pinned to the document's current DocumentVersion.
export type CollectionMember = Readonly<{
  documentSlug: string;
  docVersion: number;
  contentHash: string;
  position: number;
  delivery?: CollectionDelivery;
}>;

export type CollectionVersionSnapshot = Readonly<{
  collectionSlug: CollectionSlug;
  collectionVersion: number;
  members: readonly CollectionMember[];
  changedAt: string;
  changedBy: string;
}>;

// The genesis rule in one place: a document's first version has no
// predecessor, so `prevContentHash` is `null`; every later version links
// to the immediately-preceding head's content hash.
export function documentVersion(
  args: Readonly<{
    slug: DocumentSlug;
    docVersion: number;
    contentHash: string;
    prevContentHash: string | undefined;
    changedAt: string;
    changedBy: string;
    diffSummary?: string;
  }>,
): DocumentVersionProps {
  return compact({
    slug: args.slug,
    docVersion: args.docVersion,
    contentHash: args.contentHash,
    prevContentHash: args.prevContentHash ?? null,
    changedAt: args.changedAt,
    changedBy: args.changedBy,
    diffSummary: args.diffSummary,
  });
}

// Snapshot the resolved member set (already position-ordered) at a
// monotonically increasing per-collection version.
export function collectionVersionSnapshot(
  args: Readonly<{
    collectionSlug: CollectionSlug;
    collectionVersion: number;
    members: readonly CollectionMember[];
    changedAt: string;
    changedBy: string;
  }>,
): CollectionVersionSnapshot {
  return {
    collectionSlug: args.collectionSlug,
    collectionVersion: args.collectionVersion,
    members: args.members,
    changedAt: args.changedAt,
    changedBy: args.changedBy,
  };
}
