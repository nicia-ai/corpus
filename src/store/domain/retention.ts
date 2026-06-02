import { z } from "zod";

import { versionKey } from "./versions";

// The minimal Nicia `ProjectPolicy` subset OSS implements. Stored as
// JSON in `project.policy`; unset / absent = "forever" (no reaping).
const RetentionSchema = z
  .object({
    documentVersionDays: z.number().int().positive().optional(),
    changeEventDays: z.number().int().positive().optional(),
    blobDays: z.number().int().positive().optional(),
  })
  .strict();

const ProjectPolicySchema = z
  .object({ retention: RetentionSchema.optional() })
  .strict();

export type RetentionPolicy = Readonly<z.infer<typeof RetentionSchema>>;

// Defensive parse of the policy column (we write it, but it crosses the
// control-plane → data-plane boundary). Anything unparseable = forever.
export function parseRetention(policyJson: string | null): RetentionPolicy {
  if (policyJson === null || policyJson === "") return {};
  let raw: unknown;
  try {
    raw = JSON.parse(policyJson);
  } catch {
    return {};
  }
  const parsed = ProjectPolicySchema.safeParse(raw);
  return parsed.success ? (parsed.data.retention ?? {}) : {};
}

const MS_PER_DAY = 86_400_000;

// The instant before which records of a given age are expired.
export function cutoffIso(nowMs: number, days: number): string {
  return new Date(nowMs - days * MS_PER_DAY).toISOString();
}

export type ReapVersion = Readonly<{
  id: string;
  slug: string;
  docVersion: number;
  changedAt: string;
  contentHash: string;
}>;

export type VersionReapPlan = Readonly<{
  deleteIds: readonly string[];
  // contentHashes of the versions that survive — the blob-reap "still
  // referenced by a DocumentVersion" set.
  survivingHashes: readonly string[];
}>;

// Pure reap selection. A version is deleted iff it is older than the
// window AND it is not a document's current head AND it is not pinned by
// a live CollectionVersion — so `getDocument` and `verifyHistory` stay
// green after a sweep.
export function planVersionReap(
  args: Readonly<{
    versions: readonly ReapVersion[];
    cutoffIso: string;
    pinned: ReadonlySet<string>;
  }>,
): VersionReapPlan {
  const headBySlug = new Map<string, number>();
  for (const v of args.versions) {
    headBySlug.set(v.slug, Math.max(headBySlug.get(v.slug) ?? 0, v.docVersion));
  }
  const deleteIds: string[] = [];
  const survivingHashes = new Set<string>();
  for (const v of args.versions) {
    const isHead = headBySlug.get(v.slug) === v.docVersion;
    const isPinned = args.pinned.has(versionKey(v.slug, v.docVersion));
    const expired = v.changedAt < args.cutoffIso;
    if (expired && !isHead && !isPinned) {
      deleteIds.push(v.id);
    } else {
      survivingHashes.add(v.contentHash);
    }
  }
  return { deleteIds, survivingHashes: [...survivingHashes] };
}
