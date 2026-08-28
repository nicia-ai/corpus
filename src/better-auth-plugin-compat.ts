import type { BetterAuthPlugin } from "better-auth";

// Shared by src/auth.server.ts and src/control/auth.cli.ts, which both
// build a `betterAuth({ plugins: [...] })` config and so both need this.
//
// @better-auth/oauth-provider@1.7's declaration bundling widens its
// OpenAPI parameter literals to a union carrying explicit `key?: undefined`
// members (e.g. `items?: undefined`) instead of omitting the key. That is
// legal under the library's own (non-strict-optional) build but structurally
// fails `BetterAuthPlugin` under our `exactOptionalPropertyTypes`, and TS's
// inference failure on this one plugin collapses the *entire* `plugins`
// array's inferred type, which is why unrelated plugins (organization, jwt)
// also appear to lose endpoints downstream. Runtime behavior is unaffected —
// this is purely a `.d.mts` authoring artifact.
//
// A narrower `<T extends object>(plugin: T): T & BetterAuthPlugin` (keeping
// the plugin's own literal type in an intersection, so its endpoint names
// survive) looks like the obvious fix for the blast radius above, but is
// worse in practice: it confuses `betterAuth()`'s plugin-tuple inference
// enough that the OTHER plugins (organization, admin) lose their endpoints
// too — verified by trying it and watching `team.server.ts`'s org-endpoint
// calls fail. The blanket widen below is the smaller, verified-stable blast
// radius; `src/api.ts`'s two `.well-known` handlers re-cast `getAuth(...)`
// through oauth-provider's own metadata-helper parameter types to recover
// just the two endpoint names they need.
//
// Re-check on every oauth-provider bump; drop this the day upstream's
// declarations stop emitting bare `undefined` members.
export function asBetterAuthPlugin(plugin: unknown): BetterAuthPlugin {
  return plugin as BetterAuthPlugin;
}
