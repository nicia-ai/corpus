# Better Auth notes

Background for the Auth rules in `AGENTS.md`.

## The 1.7 bump

See the [upgrade guide](https://better-auth.com/docs/guides/1-7-upgrade-guide).

- `oauthProvider`'s `validAudiences` is gone; use `resources: [...]` plus
  `enforcePerClientResources: false`. Corpus has exactly one resource —
  the MCP audience — shared by every DCR'd client, so there is no
  per-client resource ACL to enforce.
- `account` gained a required `issuer` (unique with `accountId`), and
  `oauth_client` lost its `public` / `type` columns. Four migrations, one
  root cause: drizzle-kit hits an interactive rename-conflict prompt
  (which cannot run non-interactively) whenever a diff both adds and
  drops a column on the same table, or adds a NOT NULL column with no
  default to a non-empty table. `0001` is every purely-additive change,
  including `account.issuer` nullable-first; `0002` drops
  `oauth_client.public` / `type` on their own, safe because the app never
  reads them (verified — no reference outside the generated schema);
  `0003_backfill_account_issuer.sql` fills `issuer` per the guide's
  provider mapping (`credential` → `local:credential`, `google` →
  `https://accounts.google.com`); `0004` adds the NOT NULL + unique index
  once every row already has a value.
- `@better-auth/oauth-provider@1.7`'s bundled `.d.mts` widens some
  OpenAPI-parameter literals to include explicit `key?: undefined`
  members, which fails `BetterAuthPlugin` under our
  `exactOptionalPropertyTypes` and collapses the _entire_ inferred
  `plugins` array type, not just that one plugin. `asBetterAuthPlugin` in
  `auth.server.ts` / `auth.cli.ts` is the documented workaround;
  `src/api.ts`'s two `.well-known` handlers re-cast `getAuth(...)`
  through the metadata helpers' own parameter types to recover the
  endpoint names the workaround erases. Re-check on every oauth-provider
  bump; drop once upstream's declarations stop emitting bare `undefined`
  members.
- `@better-auth/drizzle-adapter@1.7` reads `db._?.schema` eagerly at
  construction, so `auth.cli.ts`'s schema-generation stub db can no
  longer be bare `undefined` — it is `{ _: undefined }` now.
- A DCR request with no declared `application_type` now defaults to
  `"web"`, and a `"web"` client is refused any loopback redirect URI.
  Every shipping MCP client (Claude Code, Cursor, mcp-remote) is a CLI
  app running a local loopback callback server and does not send
  `application_type`, so this silently broke unauthenticated DCR for all
  of them. `src/api.ts`'s `classifyLoopbackDcrAsNative` reclassifies an
  undeclared, all-loopback-redirect registration as `"native"` before
  Better Auth ever sees it, using the same `isLoopbackIP` predicate
  oauth-provider's own validator uses. Regression keeper:
  `test/oauth-discovery.test.ts`.
