import { cutoffIso, type RetentionPolicy } from "../store/domain/retention";
import { versionKey } from "../store/domain/versions";

import type { ReapResult } from "./contracts";
import type { ProjectUnit } from "./unit";

// Reap records past the Project's retention window. Called inside
// ProjectStore.write() so version-node, change-event, and blob deletes cannot
// tear. Heads and versions still pinned by a live CollectionVersion survive.
export async function reapExpiredRecords(
  u: ProjectUnit,
  retention: RetentionPolicy,
  nowMs: number,
): Promise<ReapResult> {
  let versionsDeleted = 0;
  let survivingHashes: readonly string[] | undefined;
  if (retention.documentVersionDays !== undefined) {
    const pinned = new Set<string>();
    for (const c of await u.versions.latestCollectionVersions()) {
      for (const m of c.members) {
        pinned.add(versionKey(m.documentSlug, m.docVersion));
      }
    }
    const r = await u.versions.reapDocumentVersions({
      cutoffIso: cutoffIso(nowMs, retention.documentVersionDays),
      pinned,
    });
    versionsDeleted = r.deleted;
    survivingHashes = r.survivingHashes;
  }

  let eventsDeleted = 0;
  if (retention.changeEventDays !== undefined) {
    eventsDeleted = await u.log.deleteOlderThan(
      cutoffIso(nowMs, retention.changeEventDays),
    );
  }

  let blobsDeleted = 0;
  if (retention.blobDays !== undefined) {
    const heads = await u.docs.listAll();
    const versionHashes =
      survivingHashes ??
      (await u.versions.allDocumentVersions()).map((v) => v.contentHash);
    const referenced = new Set<string>([
      ...heads.map((h) => h.contentHash),
      ...versionHashes,
    ]);
    blobsDeleted = await u.blobs.deleteUnreferencedOlderThan(
      cutoffIso(nowMs, retention.blobDays),
      referenced,
    );
  }

  return { versionsDeleted, eventsDeleted, blobsDeleted };
}
