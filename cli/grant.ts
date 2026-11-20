// What an API key may do: the same read < suggest < edit rule share links
// carry (`src/grant.ts` in the server). This package is published
// standalone and cannot import from the server tree, so the three values are
// mirrored here; `test/cli-grant.test.ts` fails if they drift apart.
export const CLI_GRANTS = ["read", "suggest", "edit"] as const;

export type Grant = (typeof CLI_GRANTS)[number];

// Servers that predate grants let every key write directly.
export const DEFAULT_GRANT: Grant = "edit";

export function grantAllows(held: Grant, needed: Grant): boolean {
  return CLI_GRANTS.indexOf(held) >= CLI_GRANTS.indexOf(needed);
}
