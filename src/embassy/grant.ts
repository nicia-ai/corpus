// Ordered weakest → strongest; each grant implies every grant before it.
export const EMBASSY_GRANTS = ["read", "suggest", "edit"] as const;

export type EmbassyGrant = (typeof EMBASSY_GRANTS)[number];

export function grantAllows(held: EmbassyGrant, needed: EmbassyGrant): boolean {
  return EMBASSY_GRANTS.indexOf(held) >= EMBASSY_GRANTS.indexOf(needed);
}

export function grantsAllowing(needed: EmbassyGrant): readonly EmbassyGrant[] {
  return EMBASSY_GRANTS.filter((held) => grantAllows(held, needed));
}
