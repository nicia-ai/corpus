import { inArray, lt } from "drizzle-orm";

import { contentBlobs, type LedgerDb } from "../../db";
import { gunzip, gzip } from "../../util";

// Stay comfortably below SQLite/D1's bound-parameter ceiling. A long-lived
// document can accumulate thousands of versions; retention metadata must not
// turn that valid history into one oversized `IN (...)` statement.
const HASH_LOOKUP_BATCH_SIZE = 100;

// The content-addressed blob store, as a repository. Bound to whichever
// do-sqlite handle is active (tx handle in write(), storage handle in
// read()), so dedup-on-write is correct inside and outside a transaction.
//
// This is the ONLY compression seam: bytes are gzip-compressed at rest
// and the public API stays plain `string` in / `string` out. The content
// hash is computed by callers over the uncompressed markdown, so dedup,
// the chain verifier, and the bundle contract are unaffected.
export class BlobStore {
  constructor(private readonly db: LedgerDb) {}

  // Content-addressed → idempotent. A racing identical insert is a no-op,
  // not a conflict (only `(slug, docVersion)` gates concurrency).
  async put(hash: string, bytes: string, createdAt: string): Promise<void> {
    await this.db
      .insert(contentBlobs)
      .values({ hash, bytes: Buffer.from(await gzip(bytes)), createdAt })
      .onConflictDoNothing();
  }

  async get(hash: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ bytes: contentBlobs.bytes })
      .from(contentBlobs)
      .where(inArray(contentBlobs.hash, [hash]))
      .limit(1);
    return row ? gunzip(row.bytes) : undefined;
  }

  // Resolve many hashes at once (corpus assembly, verifier, bundle).
  async getMany(hashes: readonly string[]): Promise<Map<string, string>> {
    if (hashes.length === 0) return new Map();
    const rows = await this.db
      .select({ hash: contentBlobs.hash, bytes: contentBlobs.bytes })
      .from(contentBlobs)
      .where(inArray(contentBlobs.hash, [...new Set(hashes)]));
    return new Map(
      await Promise.all(
        rows.map(async (r) => [r.hash, await gunzip(r.bytes)] as const),
      ),
    );
  }

  // Retention-aware metadata reads need to know which historical bodies still
  // exist without inflating every gzip blob. Return only the hashes present in
  // storage; callers fetch the one body the user actually selected separately.
  async existing(hashes: readonly string[]): Promise<ReadonlySet<string>> {
    if (hashes.length === 0) return new Set();
    const unique = [...new Set(hashes)];
    const batches: string[][] = [];
    for (let i = 0; i < unique.length; i += HASH_LOOKUP_BATCH_SIZE) {
      batches.push(unique.slice(i, i + HASH_LOOKUP_BATCH_SIZE));
    }
    const rows = await Promise.all(
      batches.map((batch) =>
        this.db
          .select({ hash: contentBlobs.hash })
          .from(contentBlobs)
          .where(inArray(contentBlobs.hash, batch)),
      ),
    );
    return new Set(rows.flatMap((batch) => batch.map((row) => row.hash)));
  }

  async all(): Promise<readonly { hash: string; bytes: string }[]> {
    const rows = await this.db
      .select({ hash: contentBlobs.hash, bytes: contentBlobs.bytes })
      .from(contentBlobs);
    return Promise.all(
      rows.map(async (r) => ({ hash: r.hash, bytes: await gunzip(r.bytes) })),
    );
  }

  // Retention: drop blobs older than the window that NO surviving
  // Document/DocumentVersion still references (content-addressed, so a
  // hash is safe to delete only when unreferenced).
  async deleteUnreferencedOlderThan(
    cutoffIso: string,
    referenced: ReadonlySet<string>,
  ): Promise<number> {
    const stale = await this.db
      .select({ hash: contentBlobs.hash })
      .from(contentBlobs)
      .where(lt(contentBlobs.createdAt, cutoffIso));
    const toDelete = stale.map((r) => r.hash).filter((h) => !referenced.has(h));
    if (toDelete.length === 0) return 0;
    await this.db
      .delete(contentBlobs)
      .where(inArray(contentBlobs.hash, toDelete));
    return toDelete.length;
  }
}
