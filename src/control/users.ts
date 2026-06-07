import { inArray } from "drizzle-orm";

import { parseCallerRef } from "../ids";

import type { ControlDb } from "./db";
import { apiKey, user } from "./schema";

// Sentinel `changedBy` values from the data plane that are NOT user
// ids — `""` is "no user" (system-applied edits, e.g. seed) and
// `"import"` is a bundle import's reconstruction author. Leave them
// unresolved; the UI renders them differently from a missing name.
const NOT_A_USER_ID = new Set(["", "import"]);

// Resolve a set of user ids to display names. Picks `user.name` when
// non-empty, otherwise the email — same heuristic shared by the recent-
// changes feed and the per-document version history. Returns a map so
// the caller can do a single bulk join, not N point reads.
//
// This is the canonical bridge between the data-plane DO (which carries
// only the opaque `changedBy` author id) and the control-plane identity
// table — every transport that needs to humanize an author resolves it
// through here so the heuristic can't drift between surfaces.
export async function resolveUserNames(
  db: ControlDb,
  changedByValues: readonly string[],
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(changedByValues.filter((b) => !NOT_A_USER_ID.has(b))),
  ];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(inArray(user.id, ids));
  const out = new Map<string, string>();
  for (const r of rows) out.set(r.id, r.name.trim() === "" ? r.email : r.name);
  return out;
}

// Author labels for the review surfaces. A suggestion's `createdBy` is a
// plain user id for a web edit, but for an agent proposal over MCP it is a
// namespaced CallerRef: `apikey:<apiKeyId>` (label = the key's name) or
// `oauth:<userId>` (label = the authorizing user). Humans resolve through
// resolveUserNames as before; agent refs get a human-readable label here so
// the review panel can show "who" — the UI badges the agent kind separately
// from the createdBy prefix.
export async function resolveAuthorLabels(
  db: ControlDb,
  authorIds: readonly string[],
): Promise<Map<string, string>> {
  // Resolve each author to the *human* behind it. A web edit's author is a
  // bare user id; an agent caller is a CallerRef — `oauth:<userId>` (the user
  // directly) or `apikey:<id>` (hop through api_key.userId to the key's
  // owner). "How it arrived" is recorded separately (the suggestion's
  // channel); this answers only "who". An api key with no resolvable owner
  // falls back to the key's name.
  const parsed = [...new Set(authorIds)].map((ref) => ({
    ref,
    ...parseCallerRef(ref),
  }));
  const keyIds = parsed.filter((p) => p.kind === "apikey").map((p) => p.id);

  // api_key.id → its owning user + display name. Sequential before the name
  // lookup because the owner ids come out of this read.
  const keyRows: readonly { id: string; userId: string; name: string }[] =
    keyIds.length === 0
      ? []
      : await db
          .select({ id: apiKey.id, userId: apiKey.userId, name: apiKey.name })
          .from(apiKey)
          .where(inArray(apiKey.id, keyIds));
  const keyById = new Map(keyRows.map((r) => [r.id, r]));

  // Every user id we need a name for: direct authors + the key owners.
  const userIds = [
    ...parsed.filter((p) => p.kind !== "apikey").map((p) => p.id),
    ...keyRows.map((r) => r.userId),
  ];
  const names = await resolveUserNames(db, userIds);

  const out = new Map<string, string>();
  for (const p of parsed) {
    if (p.kind === "apikey") {
      const key = keyById.get(p.id);
      const owner = key === undefined ? undefined : names.get(key.userId);
      out.set(p.ref, owner ?? key?.name ?? "API key");
    } else {
      // Never surface the raw namespaced ref. Fall back to the bare id
      // (prefix already stripped) when the user can't be resolved — e.g. a
      // deleted account behind an `oauth:` ref. For a plain web author this
      // is the same id the list showed before.
      out.set(p.ref, names.get(p.id) ?? p.id);
    }
  }
  return out;
}
