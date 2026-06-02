import { sha256 } from "../../util";

import { type CollectionMember, versionKey } from "./versions";

// Zero-IO verifier: it is handed the already-loaded version lists, the
// collection snapshots, and the blob bytes, and re-derives every invariant
// the chain promises. No DB access here — the DO loads, this decides.

export type DocumentVersionView = Readonly<{
  docVersion: number;
  contentHash: string;
  prevContentHash: string | null;
}>;

export type DocumentChain = Readonly<{
  slug: string;
  versions: readonly DocumentVersionView[];
}>;

export type CollectionVersionView = Readonly<{
  collectionSlug: string;
  collectionVersion: number;
  members: readonly CollectionMember[];
}>;

export type VerifyInput = Readonly<{
  documents: readonly DocumentChain[];
  collections: readonly CollectionVersionView[];
  // contentHash → stored bytes.
  blobs: ReadonlyMap<string, string>;
}>;

export type BrokenAt = Readonly<
  | {
      kind: "document";
      slug: string;
      docVersion: number;
      reason:
        | "missing-blob"
        | "content-hash-mismatch"
        | "chain-broken"
        | "genesis-not-null";
    }
  | {
      kind: "collection";
      collectionSlug: string;
      collectionVersion: number;
      documentSlug: string;
      docVersion: number;
      reason: "missing-version" | "content-hash-mismatch";
    }
>;

export type VerifyResult = Readonly<
  { ok: true } | { ok: false; brokenAt: BrokenAt }
>;

function broken(brokenAt: BrokenAt): VerifyResult {
  return { ok: false, brokenAt };
}

async function verifyDocument(
  doc: DocumentChain,
  blobs: ReadonlyMap<string, string>,
): Promise<VerifyResult> {
  // Oldest → newest so the genesis and parent-link checks read in order.
  // Retention may have pruned older versions, so the chain is verified
  // as-stored: true genesis (docVersion 1, if present) must have a null
  // prev, and the parent link is asserted only across *contiguous*
  // present versions (a gap means a reaped ancestor, not corruption).
  const versions = [...doc.versions].sort(
    (a, b) => a.docVersion - b.docVersion,
  );
  for (let i = 0; i < versions.length; i += 1) {
    const v = versions[i];
    if (v === undefined) continue;
    const bytes = blobs.get(v.contentHash);
    if (bytes === undefined) {
      return broken({
        kind: "document",
        slug: doc.slug,
        docVersion: v.docVersion,
        reason: "missing-blob",
      });
    }
    if ((await sha256(bytes)) !== v.contentHash) {
      return broken({
        kind: "document",
        slug: doc.slug,
        docVersion: v.docVersion,
        reason: "content-hash-mismatch",
      });
    }
    if (v.docVersion === 1) {
      if (v.prevContentHash !== null) {
        return broken({
          kind: "document",
          slug: doc.slug,
          docVersion: v.docVersion,
          reason: "genesis-not-null",
        });
      }
      continue;
    }
    const prev = versions[i - 1];
    if (
      prev?.docVersion === v.docVersion - 1 &&
      v.prevContentHash !== prev.contentHash
    ) {
      return broken({
        kind: "document",
        slug: doc.slug,
        docVersion: v.docVersion,
        reason: "chain-broken",
      });
    }
  }
  return { ok: true };
}

export async function verifyChain(input: VerifyInput): Promise<VerifyResult> {
  for (const doc of input.documents) {
    const r = await verifyDocument(doc, input.blobs);
    if (!r.ok) return r;
  }

  // Every collection member must resolve to a DocumentVersion whose
  // contentHash matches the pinned hash (reproducible-to-bytes corpus).
  const versionHash = new Map<string, string>();
  for (const doc of input.documents) {
    for (const v of doc.versions) {
      versionHash.set(versionKey(doc.slug, v.docVersion), v.contentHash);
    }
  }
  for (const col of input.collections) {
    for (const m of col.members) {
      const hash = versionHash.get(versionKey(m.documentSlug, m.docVersion));
      if (hash === undefined) {
        return broken({
          kind: "collection",
          collectionSlug: col.collectionSlug,
          collectionVersion: col.collectionVersion,
          documentSlug: m.documentSlug,
          docVersion: m.docVersion,
          reason: "missing-version",
        });
      }
      if (hash !== m.contentHash) {
        return broken({
          kind: "collection",
          collectionSlug: col.collectionSlug,
          collectionVersion: col.collectionVersion,
          documentSlug: m.documentSlug,
          docVersion: m.docVersion,
          reason: "content-hash-mismatch",
        });
      }
    }
  }
  return { ok: true };
}
