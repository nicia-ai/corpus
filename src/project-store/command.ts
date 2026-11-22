import type { CorpusSlug } from "../ids";
import type {
  CollectionChange,
  DocumentChange,
  FileChange,
} from "../store/domain/change-events";
import type { CollectionVersionSnapshot } from "../store/domain/versions";
import type { CorpusDocView } from "../store/repos/collection-graph";

import type { ProjectUnit } from "./unit";

export type DomainChange = DocumentChange | CollectionChange | FileChange;

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
  corpus: Readonly<{
    resolvedViews: (
      u: ProjectUnit,
      corpusSlug: CorpusSlug,
    ) => Promise<readonly CorpusDocView[] | undefined>;
    snapshot: (
      u: ProjectUnit,
      corpusSlug: CorpusSlug,
      changedBy: string,
      now: string,
    ) => Promise<void>;
  }>;
}>;

export function isDocumentChange(
  change: DomainChange,
): change is DocumentChange {
  return "slug" in change;
}

export function isFileChange(change: DomainChange): change is FileChange {
  return "fileSlug" in change;
}

export function isCollectionChange(
  change: DomainChange,
): change is CollectionChange {
  return "collectionSlug" in change;
}

export function commandOutcome<T>(
  result: T,
  changes: readonly DomainChange[] = [],
): CommandOutcome<T> {
  return { result, changes };
}

export function corpusSnapshotMembers(
  views: readonly CorpusDocView[],
): CollectionVersionSnapshot["members"] {
  return views.map((v) => ({
    documentSlug: v.slug,
    docVersion: v.docVersion,
    contentHash: v.contentHash,
    position: v.position,
  }));
}
