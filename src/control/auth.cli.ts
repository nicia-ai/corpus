import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, jwt, organization } from "better-auth/plugins";

import { asBetterAuthPlugin } from "../better-auth-plugin-compat";

// Source for `pnpm auth:schema`. No runtime env (CLI-only). MUST mirror
// src/auth.server.ts's plugin surface so the generated Drizzle schema covers
// every Better Auth table; `baseURL` is only here so the oauth-provider
// plugin can initialize under the generator. See AGENTS.md "Auth".
export const auth = betterAuth({
  baseURL: "http://localhost:8787",
  secret: "development",
  emailAndPassword: { enabled: true },
  // @better-auth/drizzle-adapter@1.7 reads `db._?.schema` eagerly at
  // adapter construction (to build its relation-key registry), so a bare
  // `undefined` db throws before schema generation ever runs. `{ _:
  // undefined }` satisfies that first dereference; `buildRelationKeysByModel`
  // already tolerates an undefined schema (`relationRegistry ?? {}`).
  database: drizzleAdapter(
    { _: undefined },
    {
      provider: "sqlite",
    },
  ),
  plugins: [
    jwt(),
    asBetterAuthPlugin(
      oauthProvider({ loginPage: "/sign-in", consentPage: "/consent" }),
    ),
    // Mirror src/auth.server.ts: schema-affecting options only. Runtime
    // behavior (hooks, email) lives in src/auth.server.ts, not here.
    organization({ requireEmailVerificationOnInvitation: false }),
    // Adds user.role/banned/banReason/banExpires + session.impersonatedBy
    // to the generated schema. Runtime options (adminUserIds, etc.) live
    // in src/auth.server.ts.
    admin(),
  ],
});
