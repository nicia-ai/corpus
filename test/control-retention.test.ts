import { env } from "cloudflare:test";
import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  isAccessTokenReapable,
  isInvitationReapable,
  isRefreshTokenReapable,
  isSessionReapable,
  reconcileControlPlane,
  TERMINAL_INVITATION_STATUSES,
} from "../src/control/control-retention";
import { connectControlDb } from "../src/control/db";
import { session } from "../src/control/schema/better-auth";

import { signUp } from "./_helpers";

const NOW = Date.UTC(2026, 4, 18);
const DAY = 86_400_000;
const PAST = NOW - DAY;
const FUTURE = NOW + DAY;

describe("control-plane retention — pure row selection (no D1)", () => {
  it("sweeps expired sessions / access tokens; keeps live ones", () => {
    expect(isSessionReapable({ id: "s", expiresAtMs: PAST }, NOW)).toBe(true);
    expect(isSessionReapable({ id: "s", expiresAtMs: FUTURE }, NOW)).toBe(
      false,
    );
    expect(isAccessTokenReapable({ id: "a", expiresAtMs: PAST }, NOW)).toBe(
      true,
    );
    expect(isAccessTokenReapable({ id: "a", expiresAtMs: FUTURE }, NOW)).toBe(
      false,
    );
  });

  it("refresh tokens: the call-out — revoked is reaped even when not expired", () => {
    // Rotation keeps the old row revoked with its original future
    // expiry; expiry-only would reclaim ~nothing for an active client.
    expect(
      isRefreshTokenReapable(
        { id: "r", expiresAtMs: FUTURE, revokedMs: PAST },
        NOW,
      ),
    ).toBe(true);
    expect(
      isRefreshTokenReapable(
        { id: "r", expiresAtMs: PAST, revokedMs: undefined },
        NOW,
      ),
    ).toBe(true);
    // Active and not revoked → kept.
    expect(
      isRefreshTokenReapable(
        { id: "r", expiresAtMs: FUTURE, revokedMs: undefined },
        NOW,
      ),
    ).toBe(false);
  });

  it("invitations: expired+pending, plus terminal regardless of expiry", () => {
    expect(
      isInvitationReapable(
        { id: "i", expiresAtMs: PAST, status: "pending" },
        NOW,
      ),
    ).toBe(true);
    // Not yet expired + pending → kept (still actionable).
    expect(
      isInvitationReapable(
        { id: "i", expiresAtMs: FUTURE, status: "pending" },
        NOW,
      ),
    ).toBe(false);
    // Terminal rows never expire-clean — reaped even with a future expiry.
    for (const status of TERMINAL_INVITATION_STATUSES) {
      expect(
        isInvitationReapable({ id: "i", expiresAtMs: FUTURE, status }, NOW),
      ).toBe(true);
    }
  });
});

describe("reconcileControlPlane (D1 sweep wiring)", () => {
  it("deletes expired sessions, keeps live ones, returns the reclaimed count", async () => {
    const userId = await signUp("ret");
    const db = connectControlDb(env.DB);
    const tag = crypto.randomUUID().slice(0, 8);
    const expiredId = `sess-exp-${tag}`;
    const liveId = `sess-live-${tag}`;
    const past = new Date(Date.now() - 30 * DAY);
    const future = new Date(Date.now() + 30 * DAY);

    await db.insert(session).values([
      {
        id: expiredId,
        token: `tok-exp-${tag}`,
        userId,
        expiresAt: past,
        createdAt: past,
        updatedAt: past,
      },
      {
        id: liveId,
        token: `tok-live-${tag}`,
        userId,
        expiresAt: future,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const reclaimed = await reconcileControlPlane(env);
    expect(reclaimed).toBeGreaterThanOrEqual(1);

    const remaining = await db
      .select({ id: session.id })
      .from(session)
      .where(and(inArray(session.id, [expiredId, liveId])));
    expect(remaining.map((r) => r.id)).toEqual([liveId]);

    // Idempotent: a second run finds nothing more of ours to reap.
    const survivor = await db
      .select({ id: session.id })
      .from(session)
      .where(eq(session.id, liveId));
    expect(survivor).toHaveLength(1);
  });
});
