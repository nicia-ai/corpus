import { inArray } from "drizzle-orm";

import type { ControlDb } from "./db";
import { user } from "./schema";

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
