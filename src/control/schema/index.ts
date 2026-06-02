// Better Auth owns identity (user, session, account, verification, jwks,
// oauth_*, organization, member, invitation). `./better-auth` is
// generated verbatim by `pnpm auth:schema` (npx auth@latest generate) —
// version-exact, never hand-edited. `./app` is the Nicia-owned tables
// (project, connection, api_key) that reference it.
export * from "./better-auth";
export * from "./app";
