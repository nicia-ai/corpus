// Control-plane retention. The activity-bounded D1 tables (`session`,
// `oauth_access_token`, `oauth_refresh_token`, `invitation`) grow with
// usage and nothing GC'd them. Per-table truth (verified vs Better Auth
// source):
//  - `oauth_refresh_token` is the trap: rotation keeps the old row
//    `revoked` with its original up-to-30-day-future `expires_at`, so an
//    expiry-only sweep reclaims ~nothing for an active client — sweep
//    expired OR revoked (FK-safe: `oauth_access_token.refresh_id` is
//    `ON DELETE SET NULL`).
//  - `invitation` rows never expire-clean (status flip only); sweep
//    expired-and-pending plus terminal accepted|rejected|canceled.
//  - `verification` is self-cleaning (Better Auth sweeps it) — NOT here.
//  - `pending_connect` / `oauth_connection_selection` are pure TTL and
//    never single-use-deleted (consentReferenceId fires repeatedly per
//    flow) — this sweep is their only cleanup.

import { and, eq, inArray, isNotNull, lt, or } from "drizzle-orm";

import { connectControlDb } from "./db";
import { oauthConnectionSelection, pendingConnect } from "./schema/app";
import {
  invitation,
  oauthAccessToken,
  oauthRefreshToken,
  session,
} from "./schema/better-auth";

export const TERMINAL_INVITATION_STATUSES = [
  "accepted",
  "rejected",
  "canceled",
] as const;

const PENDING_INVITATION_STATUS = "pending";

// — Pure row-selection. These predicates are the retention rule; the
// sweep below loads bounded batches with the equivalent Drizzle `where`
// and applies them, so the rule has one home and is unit-tested without
// D1 (the D1 wiring test proves the SQL agrees).

export type SessionRow = Readonly<{ id: string; expiresAtMs: number }>;
export type AccessTokenRow = Readonly<{ id: string; expiresAtMs: number }>;
export type RefreshTokenRow = Readonly<{
  id: string;
  expiresAtMs: number;
  revokedMs: number | undefined;
}>;
export type InvitationRow = Readonly<{
  id: string;
  expiresAtMs: number;
  status: string;
}>;

export const isSessionReapable = (r: SessionRow, nowMs: number): boolean =>
  r.expiresAtMs < nowMs;

export const isAccessTokenReapable = (
  r: AccessTokenRow,
  nowMs: number,
): boolean => r.expiresAtMs < nowMs;

export const isRefreshTokenReapable = (
  r: RefreshTokenRow,
  nowMs: number,
): boolean => r.expiresAtMs < nowMs || r.revokedMs !== undefined;

const TERMINAL = new Set<string>(TERMINAL_INVITATION_STATUSES);

export const isInvitationReapable = (
  r: InvitationRow,
  nowMs: number,
): boolean =>
  (r.expiresAtMs < nowMs && r.status === PENDING_INVITATION_STATUS) ||
  TERMINAL.has(r.status);

// — The sweep. Batched/LIMIT-looped bounded DELETEs so one invocation
// cannot exceed D1 statement limits.

const BATCH = 500;
// Defensive ceiling so a stuck delete can't spin forever; the next run
// continues where this one stopped.
const MAX_BATCHES = 200;

const ms = (d: Date | null): number | undefined =>
  d === null ? undefined : d.getTime();

// Load up to BATCH candidate rows, make the final cut with the pure
// predicate, delete exactly those ids, repeat until a short batch.
async function sweep<Row extends { id: string }>(
  selectBatch: () => Promise<readonly Row[]>,
  reapable: (r: Row) => boolean,
  deleteByIds: (ids: readonly string[]) => Promise<void>,
): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < MAX_BATCHES; i += 1) {
    const rows = await selectBatch();
    if (rows.length === 0) break;
    const ids = rows.filter(reapable).map((r) => r.id);
    if (ids.length > 0) await deleteByIds(ids);
    deleted += ids.length;
    if (rows.length < BATCH) break;
  }
  return deleted;
}

// Sweep the activity-bounded control-plane tables. Idempotent. Returns
// the total rows reclaimed. `nowMs` is the test clock seam (mirrors
// `reapExpired` / `reconcileRetention`); production uses the wall clock.
export async function reconcileControlPlane(
  env: Env,
  nowMs?: number,
): Promise<number> {
  const db = connectControlDb(env.DB);
  const now = nowMs ?? Date.now();
  const nowDate = new Date(now);

  // Independent tables, no shared transaction — fan out across them
  // (each inner batch loop stays sequential).
  const counts = await Promise.all([
    sweep(
      () =>
        db
          .select({ id: session.id, expiresAt: session.expiresAt })
          .from(session)
          .where(lt(session.expiresAt, nowDate))
          .limit(BATCH),
      (r) =>
        isSessionReapable(
          { id: r.id, expiresAtMs: r.expiresAt.getTime() },
          now,
        ),
      async (ids) => {
        await db.delete(session).where(inArray(session.id, [...ids]));
      },
    ),
    sweep(
      () =>
        db
          .select({
            id: oauthAccessToken.id,
            expiresAt: oauthAccessToken.expiresAt,
          })
          .from(oauthAccessToken)
          .where(lt(oauthAccessToken.expiresAt, nowDate))
          .limit(BATCH),
      (r) =>
        isAccessTokenReapable(
          { id: r.id, expiresAtMs: r.expiresAt.getTime() },
          now,
        ),
      async (ids) => {
        await db
          .delete(oauthAccessToken)
          .where(inArray(oauthAccessToken.id, [...ids]));
      },
    ),
    sweep(
      () =>
        db
          .select({
            id: oauthRefreshToken.id,
            expiresAt: oauthRefreshToken.expiresAt,
            revoked: oauthRefreshToken.revoked,
          })
          .from(oauthRefreshToken)
          .where(
            or(
              lt(oauthRefreshToken.expiresAt, nowDate),
              isNotNull(oauthRefreshToken.revoked),
            ),
          )
          .limit(BATCH),
      (r) =>
        isRefreshTokenReapable(
          {
            id: r.id,
            expiresAtMs: r.expiresAt.getTime(),
            revokedMs: ms(r.revoked),
          },
          now,
        ),
      async (ids) => {
        await db
          .delete(oauthRefreshToken)
          .where(inArray(oauthRefreshToken.id, [...ids]));
      },
    ),
    sweep(
      () =>
        db
          .select({
            id: pendingConnect.userId,
            expiresAt: pendingConnect.expiresAt,
          })
          .from(pendingConnect)
          .where(lt(pendingConnect.expiresAt, nowDate))
          .limit(BATCH),
      (r) => r.expiresAt.getTime() < now,
      async (ids) => {
        await db
          .delete(pendingConnect)
          .where(inArray(pendingConnect.userId, [...ids]));
      },
    ),
    sweep(
      () =>
        db
          .select({
            id: oauthConnectionSelection.selectionKey,
            expiresAt: oauthConnectionSelection.expiresAt,
          })
          .from(oauthConnectionSelection)
          .where(lt(oauthConnectionSelection.expiresAt, nowDate))
          .limit(BATCH),
      (r) => r.expiresAt.getTime() < now,
      async (ids) => {
        await db
          .delete(oauthConnectionSelection)
          .where(inArray(oauthConnectionSelection.selectionKey, [...ids]));
      },
    ),
    sweep(
      () =>
        db
          .select({
            id: invitation.id,
            expiresAt: invitation.expiresAt,
            status: invitation.status,
          })
          .from(invitation)
          .where(
            or(
              and(
                lt(invitation.expiresAt, nowDate),
                eq(invitation.status, PENDING_INVITATION_STATUS),
              ),
              inArray(invitation.status, [...TERMINAL_INVITATION_STATUSES]),
            ),
          )
          .limit(BATCH),
      (r) =>
        isInvitationReapable(
          { id: r.id, expiresAtMs: r.expiresAt.getTime(), status: r.status },
          now,
        ),
      async (ids) => {
        await db.delete(invitation).where(inArray(invitation.id, [...ids]));
      },
    ),
  ]);

  return counts.reduce((a, b) => a + b, 0);
}
