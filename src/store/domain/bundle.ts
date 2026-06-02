import { z } from "zod";

import { alwaysIncludeBudgetTokensZ, sha256 } from "../../util";

import {
  collectionDelivery,
  DEFAULT_COLLECTION_DELIVERY,
} from "./collection-expand";
import type { CollectionMember } from "./versions";

// The portable collection bundle — the cross-product alignment contract
// (a canonical spec maintained separately, outside this public repo).
// That directory layout is modeled here as one JSON-serializable object
// whose fields ARE the files; a deterministic serialization makes
// `export → import → export` byte-identical.

export type BundleSource = Readonly<{
  organization: string;
  project: string;
}>;

export const BUNDLE_KIND = "corpus-bundle";
// Bumped to "3": `deliverWhole` (collection-level always-ship-everything
// override) was removed in favor of a per-row "Always include" toggle
// (the existing `delivery: core | reference` member field already
// expresses it); replaced at the collection level with
// `alwaysIncludeBudgetTokens`, the per-collection size threshold the
// authoring UI compares the assembled `core` set against. Previously
// bumped to "2" for the Context → Collection identifier rebrand.
export const BUNDLE_VERSION = "3";
export const PRODUCT = "corpus";
// Kept in lockstep with package.json `version` (asserted by the bundle
// contract test) — the worker bundle must not import package.json.
export const PRODUCT_VERSION = "0.1.0";

const HistoryLineSchema = z.object({
  slug: z.string().min(1),
  docVersion: z.number().int().positive(),
  contentHash: z.string().min(1),
  prevContentHash: z.string().nullable(),
  changedAt: z.string(),
  changedBy: z.string(),
  diffSummary: z.string().optional(),
});
export type HistoryLine = Readonly<z.infer<typeof HistoryLineSchema>>;

const DocMetaSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  docVersion: z.number().int().nonnegative(),
  contentHash: z.string().min(1),
  updatedAt: z.string(),
});
export type DocMeta = Readonly<z.infer<typeof DocMetaSchema>>;

const MemberSchema = z.object({
  documentSlug: z.string().min(1),
  documentVersion: z.number().int().positive(),
  contentHash: z.string().min(1),
  position: z.number().int().nonnegative(),
  delivery: z.enum(["core", "reference"]).default(DEFAULT_COLLECTION_DELIVERY),
});
export type BundleMember = Readonly<z.infer<typeof MemberSchema>>;

// The bundle is the only place `docVersion` (internal) is renamed to
// `documentVersion` (the wire contract). Both directions live here so
// the rename is never hand-transposed at a call site. Position-sorted
// so a snapshot serializes deterministically.
export function bundleMembersOf(
  members: readonly CollectionMember[],
): BundleMember[] {
  return [...members]
    .sort((a, b) => a.position - b.position)
    .map((m) => ({
      documentSlug: m.documentSlug,
      documentVersion: m.docVersion,
      contentHash: m.contentHash,
      position: m.position,
      delivery: collectionDelivery(m.delivery),
    }));
}

export function collectionMembersOf(
  members: readonly BundleMember[],
): CollectionMember[] {
  return [...members]
    .sort((a, b) => a.position - b.position)
    .map((m) => ({
      documentSlug: m.documentSlug,
      docVersion: m.documentVersion,
      contentHash: m.contentHash,
      position: m.position,
      delivery: collectionDelivery(m.delivery),
    }));
}

// Bundle folder delta — ratified against the canonical bundle contract
// (maintained separately, outside this public repo). Folders ride in the
// manifest only (no file body); `rootHash` is UNCHANGED — folders /
// `filename` / placement are head/derived metadata, excluded exactly as
// collections are.
const FolderSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  parentSlug: z.string().nullable(),
  position: z.number().int().nonnegative(),
});
export type BundleFolder = Readonly<z.infer<typeof FolderSchema>>;

// Deterministic order: lexically by slug (the contract sort key),
// mirroring `bundleMembersOf` — the only place bundle ordering lives.
export function sortedBundleFolders(
  folders: readonly BundleFolder[],
): BundleFolder[] {
  return [...folders].sort((a, b) => a.slug.localeCompare(b.slug));
}

// Parents strictly before children, deterministic (slug-sorted base +
// parents-first DFS), cycle-guarded. Bundle import must create a folder
// after its parent; this replaces an O(n²) fixpoint with one O(n) pass.
export function foldersInDependencyOrder(
  folders: readonly BundleFolder[],
): BundleFolder[] {
  const sorted = sortedBundleFolders(folders);
  const bySlug = new Map(sorted.map((f) => [f.slug, f]));
  const out: BundleFolder[] = [];
  const emitted = new Set<string>();
  const visit = (f: BundleFolder, guard: Set<string>): void => {
    if (emitted.has(f.slug) || guard.has(f.slug)) return;
    guard.add(f.slug);
    const parent = f.parentSlug === null ? undefined : bySlug.get(f.parentSlug);
    if (parent !== undefined) visit(parent, guard);
    emitted.add(f.slug);
    out.push(f);
  };
  for (const f of sorted) visit(f, new Set());
  return out;
}

const BundleCollectionSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  // The size threshold (in approximate tokens) the authoring UI compares
  // the assembled "always include" (delivery=core) set against; purely
  // informational — MCP read_collection always assembles and ships the
  // core set, never enforces this. Per-collection so an owner with a
  // larger context window can raise it.
  alwaysIncludeBudgetTokens: alwaysIncludeBudgetTokensZ,
  collectionVersion: z.number().int().positive(),
  members: z.array(MemberSchema),
});
export type BundleCollection = Readonly<z.infer<typeof BundleCollectionSchema>>;

// Minimal pre-flight schema for import: extract only the bundle
// version, so a mismatch (e.g. an exported-on-v2 bundle hitting a v3
// importer) surfaces as a structured `version-mismatch` ImportResult
// instead of a generic Zod literal-mismatch on the full schema (which
// would otherwise also fail at every field that changed shape between
// versions). Permissive on everything except the version itself.
export const BundleVersionPreflightSchema = z.looseObject({
  manifest: z.looseObject({
    bundleVersion: z.string().optional(),
  }),
});
export type BundleVersionPreflight = Readonly<
  z.infer<typeof BundleVersionPreflightSchema>
>;

const ManifestSchema = z.object({
  kind: z.literal(BUNDLE_KIND),
  bundleVersion: z.literal(BUNDLE_VERSION),
  exportedAt: z.string(),
  source: z.object({
    product: z.literal(PRODUCT),
    productVersion: z.string(),
    organization: z.string(),
    project: z.string(),
  }),
  documents: z.array(
    z.object({
      slug: z.string().min(1),
      title: z.string().min(1),
      docVersion: z.number().int().nonnegative(),
      contentHash: z.string().min(1),
      // Folder delta: `slug` stays the identity key; `filename` is the
      // original basename, `folderSlug` the single-parent placement.
      filename: z.string().min(1),
      folderSlug: z.string().nullable(),
    }),
  ),
  folders: z.array(FolderSchema),
  collections: z.array(
    z.object({
      slug: z.string().min(1),
      name: z.string().min(1),
      alwaysIncludeBudgetTokens: alwaysIncludeBudgetTokensZ,
      collectionVersion: z.number().int().positive(),
      members: z.array(MemberSchema),
    }),
  ),
  integrity: z.object({
    algorithm: z.literal("sha256"),
    rootHash: z.string().min(1),
  }),
});
export type Manifest = Readonly<z.infer<typeof ManifestSchema>>;

export const BundleSchema = z.object({
  manifest: ManifestSchema,
  documents: z.record(
    z.string(),
    z.object({ md: z.string(), meta: DocMetaSchema }),
  ),
  collections: z.record(z.string(), BundleCollectionSchema),
  history: z.record(z.string(), z.array(HistoryLineSchema)),
  blobs: z.record(z.string(), z.string()),
});
export type Bundle = Readonly<z.infer<typeof BundleSchema>>;

// Discriminated outcome of parsing an arbitrary import payload: a
// `version-mismatch` carries the got/expected pair so callers can show
// the owner what to re-export (a generic Zod literal mismatch lacks the
// pair). Pure — the server fn calls this then dispatches to the DO on
// success.
export type BundleParseResult = Readonly<
  | { ok: true; bundle: Bundle }
  | { ok: false; reason: "version-mismatch"; got: string; expected: string }
  | { ok: false; reason: "invalid-bundle-shape"; details: string }
>;

export function parseBundle(data: unknown): BundleParseResult {
  const preflight = BundleVersionPreflightSchema.safeParse(data);
  if (!preflight.success) {
    return {
      ok: false,
      reason: "invalid-bundle-shape",
      details:
        "Not a Corpus bundle: missing or malformed `manifest.bundleVersion`.",
    };
  }
  // A preflight match with no `bundleVersion` is a structurally invalid
  // payload, not a version mismatch — surface it that way so the UI
  // can guide the owner to a real bundle rather than asking them to
  // re-export at a different version.
  const got = preflight.data.manifest.bundleVersion;
  if (got === undefined) {
    return {
      ok: false,
      reason: "invalid-bundle-shape",
      details: "manifest.bundleVersion is missing.",
    };
  }
  if (got !== BUNDLE_VERSION) {
    return {
      ok: false,
      reason: "version-mismatch",
      got,
      expected: BUNDLE_VERSION,
    };
  }
  const parsed = BundleSchema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid-bundle-shape",
      details: parsed.error.message,
    };
  }
  return { ok: true, bundle: parsed.data };
}

// `integrity.rootHash` = sha256 over the newline-joined, lexically
// sorted set of `"<slug> <docVersion> <contentHash> <prevContentHash>"`
// lines across all history. Genesis `prevContentHash` is null, rendered
// as the literal `null`. Recomputed on import; mismatch rejects.
export async function computeRootHash(
  history: Readonly<Record<string, readonly HistoryLine[]>>,
): Promise<string> {
  const lines: string[] = [];
  for (const slug of Object.keys(history)) {
    for (const v of history[slug] ?? []) {
      lines.push(
        `${v.slug} ${String(v.docVersion)} ${v.contentHash} ${
          v.prevContentHash ?? "null"
        }`,
      );
    }
  }
  lines.sort();
  return sha256(lines.join("\n"));
}

// Deterministic serialization: recursively sort object keys so two
// exports of the same content are byte-identical.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
    return out;
  }
  return value;
}
