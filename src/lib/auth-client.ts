import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { adminClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { z } from "zod";

// `oauthProviderClient` is the server plugin's required client half: its
// fetch hook reads the signed authorization query off `window.location.search`
// and forwards it as `oauth_query` on every non-GET auth call (sign-in,
// `oauth2.continue`, `oauth2.consent`), which is how the server re-establishes
// the in-flight OAuth request state across our custom `/sign-in`,
// `/connect/select`, and `/consent` pages. It also surfaces the typed
// `authClient.oauth2.*` methods.
// `adminClient` surfaces the platform-admin methods (listUsers, setRole,
// banUser, impersonateUser, …). Platform admin (user.role === "admin")
// is product-wide and distinct from an org "owner" (member.role) — see
// control/access.ts. These call /api/auth/admin/*, which the server
// gates on the admin role (bootstrapped from ADMIN_EMAILS at signup).
export const authClient = createAuthClient({
  plugins: [oauthProviderClient(), adminClient()],
});

// When a sign-in/sign-up happens mid-OAuth, the server resumes the
// authorization and returns `{ redirect: true, url }` instead of a session;
// the client's built-in redirectPlugin then navigates the browser. Callers
// use this to detect that case and stand down rather than racing it with an
// in-app navigation. The response shape isn't in the typed result, so we
// validate it at this boundary.
const oauthResumeSchema = z.object({
  redirect: z.literal(true),
  url: z.string(),
});

export function isOAuthResume(data: unknown): boolean {
  return oauthResumeSchema.safeParse(data).success;
}
