// What a credential may do to the documents it reaches. One rule for every
// credential that carries it (share links, API keys): ordered weakest →
// strongest, each grant implies every grant before it.
//   read    — fetch only
//   suggest — also propose changes a person reviews
//   edit    — also write directly
export const GRANTS = ["read", "suggest", "edit"] as const;

export type Grant = (typeof GRANTS)[number];

export function grantAllows(held: Grant, needed: Grant): boolean {
  return GRANTS.indexOf(held) >= GRANTS.indexOf(needed);
}

export function grantsAllowing(needed: Grant): readonly Grant[] {
  return GRANTS.filter((held) => grantAllows(held, needed));
}
