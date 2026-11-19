// How long a share link lives. An ongoing collaboration (a page agents keep
// updating for days) must not silently die after the intake-style default, so
// the owner picks a lifetime at creation and can extend a live link later.
export const EMBASSY_EXPIRIES = ["7d", "30d", "90d", "never"] as const;

export type EmbassyExpiry = (typeof EMBASSY_EXPIRIES)[number];

export const DEFAULT_EMBASSY_EXPIRY: EmbassyExpiry = "30d";

const DAY_MS = 24 * 60 * 60 * 1000;

const EXPIRY_DAYS = { "7d": 7, "30d": 30, "90d": 90 } as const;

// `expires_at` is NOT NULL, so "never" is the far-future end of the Date range
// the column can carry (9999-12-31T23:59:59Z).
export const EMBASSY_NEVER_EXPIRES_AT = 253_402_300_799_000;

export const EMBASSY_EXPIRY_LABELS: Readonly<Record<EmbassyExpiry, string>> = {
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
  never: "No expiry",
};

export function embassyExpiresAt(expiry: EmbassyExpiry, nowMs: number): number {
  if (expiry === "never") return EMBASSY_NEVER_EXPIRES_AT;
  return nowMs + EXPIRY_DAYS[expiry] * DAY_MS;
}

export function neverExpires(expiresAt: number): boolean {
  return expiresAt >= EMBASSY_NEVER_EXPIRES_AT;
}
