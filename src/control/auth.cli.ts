import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, jwt, organization } from "better-auth/plugins";

// Source for `pnpm auth:schema`. No runtime env (CLI-only). MUST mirror
// src/auth.server.ts's plugin surface so the generated Drizzle schema covers
// every Better Auth table; `baseURL` is only here so the oauth-provider
// plugin can initialize under the generator. See AGENTS.md "Auth".
export const auth = betterAuth({
  baseURL: "http://localhost:8787",
  secret: "development",
  emailAndPassword: { enabled: true },
  database: drizzleAdapter(undefined as unknown as never, {
    provider: "sqlite",
  }),
  plugins: [
    jwt(),
    oauthProvider({ loginPage: "/sign-in", consentPage: "/consent" }),
    // Mirror src/auth.server.ts: schema-affecting options only. Runtime
    // behavior (hooks, email) lives in src/auth.server.ts, not here.
    organization({ requireEmailVerificationOnInvitation: false }),
    // Adds user.role/banned/banReason/banExpires + session.impersonatedBy
    // to the generated schema. Runtime options (adminUserIds, etc.) live
    // in src/auth.server.ts.
    admin(),
  ],
});
