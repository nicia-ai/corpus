import type { CollectionSlug, DocumentSlug, FolderSlug } from "../ids";
import type {
  CollectionChange,
  DocumentChange,
} from "../store/domain/change-events";
import type {
  CollectionDelivery,
  FolderTreeNode,
} from "../store/domain/collection-expand";
import type {
  CollectionMember,
  CollectionVersionSnapshot,
} from "../store/domain/versions";
import type { CollectionDocView } from "../store/repos/collection-graph";

import type { ProjectUnit } from "./unit";

export type DomainChange = DocumentChange | CollectionChange;

export type CommandOutcome<T> = Readonly<{
  result: T;
  changes: readonly DomainChange[];
  /** Test seam: throw after ledger + outbox recording to verify rollback. */
  rollbackAfterRecord?: boolean;
}>;

export type ProjectCommandContext = Readonly<{
  u: ProjectUnit;
  now: string;
  hash: (bytes: string) => Promise<string>;
  collection: Readonly<{
    resolvedViews: (
      u: ProjectUnit,
      collectionSlug: CollectionSlug,
    ) => Promise<readonly CollectionDocView[] | undefined>;
    snapshot: (
      u: ProjectUnit,
      collectionSlug: CollectionSlug,
      changedBy: string,
      now: string,
    ) => Promise<void>;
  }>;
}>;

export type CollectionEntrySnapshot = Readonly<{
  documentSlug: DocumentSlug;
  docVersion: number;
  contentHash: string;
  position: number;
  delivery: CollectionDelivery;
}>;

export type FolderTreeLoader = (
  folderSlug: FolderSlug,
) => Promise<Map<string, FolderTreeNode>>;

export function isDocumentChange(
  change: DomainChange,
): change is DocumentChange {
  return "slug" in change;
}

export function commandOutcome<T>(
  result: T,
  changes: readonly DomainChange[] = [],
): CommandOutcome<T> {
  return { result, changes };
}

export function collectionMembers(
  views: readonly CollectionEntrySnapshot[],
): CollectionMember[] {
  return views.map((v) => ({
    documentSlug: v.documentSlug,
    docVersion: v.docVersion,
    contentHash: v.contentHash,
    position: v.position,
    delivery: v.delivery,
  }));
}

export function collectionSnapshotMembers(
  views: readonly CollectionDocView[],
): CollectionVersionSnapshot["members"] {
  return views.map((v) => ({
    documentSlug: v.slug,
    docVersion: v.docVersion,
    contentHash: v.contentHash,
    position: v.position,
    delivery: v.delivery,
  }));
}
