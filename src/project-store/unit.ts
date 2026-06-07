import type { BlobStore } from "../store/repos/blob-store";
import type { BlockMapRepo } from "../store/repos/block-map";
import type { ChangeLog } from "../store/repos/change-log";
import type { CollectionGraph } from "../store/repos/collection-graph";
import type { CommentRepo } from "../store/repos/comment";
import type { DocumentRepo } from "../store/repos/document-repo";
import type { FolderRepo } from "../store/repos/folder-repo";
import type { InstrumentationOutbox } from "../store/repos/instrumentation-outbox";
import type { SuggestionRepo } from "../store/repos/suggestion";
import type { VersionRepo } from "../store/repos/version-repo";

// The repositories bound to one handle: tx-scoped for writes, storage for
// reads. Atomicity is `ctx.storage.transaction` on ProjectStore's SQLite, so
// the unit of work is constructed by ProjectStore and passed to command
// handlers rather than opened above the DO.
export type ProjectUnit = Readonly<{
  docs: DocumentRepo;
  cols: CollectionGraph;
  folders: FolderRepo;
  log: ChangeLog;
  blobs: BlobStore;
  versions: VersionRepo;
  outbox: InstrumentationOutbox;
  blockMaps: BlockMapRepo;
  comments: CommentRepo;
  suggestions: SuggestionRepo;
}>;
