import type { ProjectId } from "../ids";
import { FILE_HASH_PATTERN } from "../store/domain/file-kinds";
import {
  hashOfObjectKey,
  OBJECT_DELETE_BATCH,
  type ObjectStore,
  projectObjectPrefix,
  type StoredObject,
} from "../store/repos/object-store";

// Why an upload can leave an object behind: R2 is outside the DO transaction,
// so an upload writes the BYTES first and the METADATA second, and a failure
// between the two strands bytes that no `File` node names. (The reverse order
// would strand metadata, which a person sees as a broken file; never that.)
// This sweep is what makes bytes-first safe: it deletes an object only when
//
//   * it is older than the grace window, so an upload whose metadata
//     transaction has not committed yet is never mistaken for an orphan, and
//   * no surviving node references its hash (soft-deleted nodes count: the
//     bytes outlive the node until the reaper removes it).
//
// Every upload re-puts its object, even one that already exists, so `uploaded`
// always marks the latest attempt and the grace window runs from it. The
// keeper is `test/files/file-orphan-sweep.test.ts`.
export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

export type SweepResult = Readonly<{ scanned: number; deleted: number }>;

async function* objectsUnder(
  store: ObjectStore,
  prefix: string,
): AsyncGenerator<StoredObject> {
  let cursor: string | undefined;
  do {
    const page = await store.list(prefix, cursor);
    yield* page.objects;
    cursor = page.cursor;
  } while (cursor !== undefined);
}

async function deleteAll(
  store: ObjectStore,
  keys: readonly string[],
): Promise<void> {
  for (let i = 0; i < keys.length; i += OBJECT_DELETE_BATCH) {
    await store.delete(keys.slice(i, i + OBJECT_DELETE_BATCH));
  }
}

// Delete a project's orphaned objects. `referencedHashes` is read AFTER the
// listing, so an object whose metadata committed between the two is seen as
// referenced; and each candidate's age is checked once more immediately
// before it is deleted, so a re-put during the sweep spares it.
export async function sweepOrphanObjects(
  args: Readonly<{
    store: ObjectStore;
    projectId: ProjectId;
    referencedHashes: () => Promise<readonly string[]>;
    nowMs: number;
  }>,
): Promise<SweepResult> {
  const { store, projectId, nowMs } = args;
  const cutoff = nowMs - ORPHAN_GRACE_MS;
  const stale: StoredObject[] = [];
  let scanned = 0;
  for await (const object of objectsUnder(
    store,
    projectObjectPrefix(projectId),
  )) {
    scanned += 1;
    const hash = hashOfObjectKey(projectId, object.key);
    if (
      hash !== undefined &&
      FILE_HASH_PATTERN.test(hash) &&
      object.uploadedMs < cutoff
    ) {
      stale.push(object);
    }
  }
  if (stale.length === 0) return { scanned, deleted: 0 };

  const referenced = new Set(await args.referencedHashes());
  const doomed: string[] = [];
  for (const object of stale) {
    const hash = hashOfObjectKey(projectId, object.key);
    if (hash === undefined || referenced.has(hash)) continue;
    const current = await store.head(object.key);
    if (current !== undefined && current.uploadedMs < cutoff) {
      doomed.push(object.key);
    }
  }
  await deleteAll(store, doomed);
  return { scanned, deleted: doomed.length };
}

// A deleted project's objects, all of them: no grace window, no references.
export async function purgeProjectObjects(
  store: ObjectStore,
  projectId: ProjectId,
): Promise<number> {
  const keys: string[] = [];
  for await (const object of objectsUnder(
    store,
    projectObjectPrefix(projectId),
  )) {
    keys.push(object.key);
  }
  await deleteAll(store, keys);
  return keys.length;
}
