import { desc, eq } from "drizzle-orm";

import {
  type BlockMapEntry,
  documentBlockMap,
  documentBlockSeq,
  type LedgerDb,
  type StoredBlockMap,
} from "../../db";

// Per-version block map + per-document block-id allocator. Non-canonical
// side state for anchoring: stores stable block ids (+ kind + the parser
// version that produced them) so anchors can be rebased across saves. The
// block TEXT is not stored — callers recover it by re-parsing the version's
// blob, guarded by the parser version. All Drizzle noise lives here; types
// are inferred from the schema.
export class BlockMapRepo {
  constructor(private readonly db: LedgerDb) {}

  // The block map of the document's most recent mapped version, if any.
  async headMap(documentSlug: string): Promise<StoredBlockMap | undefined> {
    const [row] = await this.db
      .select()
      .from(documentBlockMap)
      .where(eq(documentBlockMap.documentSlug, documentSlug))
      .orderBy(desc(documentBlockMap.docVersion))
      .limit(1);
    return row;
  }

  async putMap(
    documentSlug: string,
    docVersion: number,
    parserVersion: number,
    blocks: readonly BlockMapEntry[],
  ): Promise<void> {
    await this.db
      .insert(documentBlockMap)
      .values({ documentSlug, docVersion, parserVersion, blocks })
      .onConflictDoUpdate({
        target: [documentBlockMap.documentSlug, documentBlockMap.docVersion],
        set: { parserVersion, blocks },
      });
  }

  // Next unused block-id ordinal for the document (0 if it has none yet).
  // Ordinals are monotonic and never reused, so a stale anchor's block id
  // can never collide with a future unrelated block.
  async nextOrdinal(documentSlug: string): Promise<number> {
    const [row] = await this.db
      .select({ next: documentBlockSeq.next })
      .from(documentBlockSeq)
      .where(eq(documentBlockSeq.documentSlug, documentSlug))
      .limit(1);
    return row?.next ?? 0;
  }

  async setOrdinal(documentSlug: string, next: number): Promise<void> {
    await this.db
      .insert(documentBlockSeq)
      .values({ documentSlug, next })
      .onConflictDoUpdate({
        target: documentBlockSeq.documentSlug,
        set: { next },
      });
  }
}
