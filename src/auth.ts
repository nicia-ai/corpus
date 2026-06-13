import {
  getOAuthProviderState,
  oauthProvider,
} from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { admin, jwt, organization } from "better-auth/plugins";

import { resolveConnection } from "./control/connection-resolution";
import { connectControlDb } from "./control/db";
import { entitlementsOf, QuotaExceededError } from "./control/entitlements";
import { resolveServerEnv, type ServerEnv } from "./control/env";
import { connectionClaimKey, readSelection } from "./control/oauth-selection";
import {
  bumpOrgProjectsEpoch,
  materializeDefaultProject,
  purgeOrgProjects,
} from "./control/org-lifecycle";
import { adminAudit } from "./control/schema/app";
import { asOrganizationId } from "./ids";

// Per-(secret,url) cached instance, NOT a module singleton — the auth
// instance is bound to `env.DB` which only exists per request in Workers.
// Mirrors the proven tanstack-starter wiring.
let cachedAuth: ReturnType<typeof create> | undefined;
let cachedKey: string | undefined;

const INVITATION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

// Platform-admin endpoint paths whose successful calls are recorded to
// `admin_audit` (the after-hook below). Read-only admin endpoints
// (list-users, get-user) are deliberately omitted — only mutations are
// audited. Keys are Better Auth's admin route paths; values are stable
// action names stored in the log.
const AUDITED_ADMIN_ACTIONS: Readonly<Record<string, string>> = {
  "/admin/set-role": "user.set_role",
  "/admin/ban-user": "user.ban",
  "/admin/unban-user": "user.unban",
  "/admin/impersonate-user": "user.impersonate",
  "/admin/stop-impersonating": "user.stop_impersonating",
  "/admin/remove-user": "user.remove",
  "/admin/revoke-user-sessions": "user.revoke_sessions",
  "/admin/set-user-password": "user.set_password",
  "/admin/create-user": "user.create",
  "/admin/update-user": "user.update",
};

function create(env: Env, runtime: ServerEnv) {
  return betterAuth({
    baseURL: runtime.BETTER_AUTH_URL,
    secret: runtime.BETTER_AUTH_SECRET,
    emailAndPassword: { enabled: true },
    // Google is opt-in: present only when a self-hoster supplies both
    // credentials (resolveServerEnv derives `runtime.google`). Identity
    // only — no `accessType: "offline"` / refresh tokens, since we never
    // call a Google API on the user's behalf.
    ...(runtime.google ? { socialProviders: { google: runtime.google } } : {}),
    // The `oauth_client_register` seam. DCR lives *inside* Better Auth
    // at `POST /oauth2/register`, not in an OSS transport we own, so a
    // global `hooks.before` is the only gate point (no plugin fork). A
    // hook has no request context → the default impl (unbounded in OSS).
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/oauth2/register") return;
        try {
          await entitlementsOf(undefined).assertWithinQuota({
            action: "oauth_client_register",
          });
        } catch (e) {
          if (e instanceof QuotaExceededError) {
            throw new APIError("FORBIDDEN", { message: e.message });
          }
          throw e;
        }
      }),
      // Audit every successful platform-admin mutation (ban, set-role,
      // impersonate, delete, …) to `admin_audit`. Centralized here so it
      // captures the action however it was invoked (client adminClient or
      // direct API) and can't be bypassed from the UI. Best-effort: a
      // logging failure must never roll back the action itself.
      after: createAuthMiddleware(async (ctx) => {
        const action = AUDITED_ADMIN_ACTIONS[ctx.path];
        if (action === undefined) return;
        // The after-hook fires even when the endpoint failed — Better Auth
        // catches a thrown APIError as the response, then runs after-hooks
        // (see better-auth to-auth-endpoints). Auditing here unconditionally
        // would log mutations that never happened, so skip a failed call.
        const returned = (ctx.context as { returned?: unknown }).returned;
        if (returned instanceof APIError) return;
        try {
          // During impersonation the request session is the impersonated
          // user; the operator who triggered the action is `impersonatedBy`
          // (e.g. stop-impersonating runs in the impersonated session).
          // Attribute the audit to the operator, not the impersonated user.
          const session = ctx.context.session as
            | {
                user?: { id?: string };
                session?: { impersonatedBy?: string | null };
              }
            | undefined;
          const actorUserId =
            session?.session?.impersonatedBy ?? session?.user?.id;
          if (actorUserId === undefined) return;
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          // Safe metadata subset only — never passwords or session tokens.
          const meta: Record<string, string> = {};
          if (typeof body.role === "string") meta.role = body.role;
          if (typeof body.banReason === "string") {
            meta.banReason = body.banReason;
          }
          if (typeof body.email === "string") meta.email = body.email;
          await connectControlDb(env.DB)
            .insert(adminAudit)
            .values({
              actorUserId,
              action,
              targetType: "user",
              targetId: typeof body.userId === "string" ? body.userId : null,
              metadata:
                Object.keys(meta).length > 0 ? JSON.stringify(meta) : null,
            });
        } catch (error) {
          console.error("[admin-audit] failed to record", ctx.path, error);
        }
      }),
    },
    // Bootstrap platform admins by email: a new account whose email is
    // listed in ADMIN_EMAILS is created with role="admin" in the same
    // insert. Better Auth's admin endpoints (set-role, ban, impersonate)
    // gate on that role, so the first admin can act — not just view —
    // without an id lookup, a SQL write, or a restart. No email
    // verification here, so this trusts the signup email; on a public
    // deploy, claim the admin email by signing up before anyone else can.
    databaseHooks: {
      user: {
        create: {
          before: (user) =>
            Promise.resolve(
              runtime.adminEmails.includes(user.email.toLowerCase())
                ? { data: { ...user, role: "admin" } }
                : undefined,
            ),
        },
      },
    },
    // Signed session-cookie cache: sessionRequestMiddleware reads the
    // session on every request, so without this each navigation is a D1
    // session+user join. 60s cache → signature verify only on the warm
    // path; revocation still takes effect within maxAge.
    session: { cookieCache: { enabled: true, maxAge: 60 } },
    database: drizzleAdapter(connectControlDb(env.DB), { provider: "sqlite" }),
    plugins: [
      jwt(),
      // OAuth Provider plugin = MCP-spec bearer auth, Connection-bound.
      // NOT the deprecated better-auth mcp plugin.
      //
      // - DCR is NOT on by default — every shipping MCP client
      //   (Claude Code/Cursor/mcp-remote DCR-only, VS Code DCR-first) is
      //   DCR; static client_id is the worst-supported path. Unauth DCR
      //   because an MCP client registers BEFORE any user session. Abuse
      //   is bounded by the `oauth_client_register` entitlement (above).
      // - `validAudiences` must include `${base}/mcp` or a spec-compliant
      //   `resource=${base}/mcp` is rejected at issuance.
      // - `accessTokenExpiresIn: 900` is NOT a revocation latency:
      //   resolveConnection is uncached so a deleted Connection/member
      //   is dead next request; 900 s is only an un-revoked token's
      //   lifetime.
      // - The Connection binds at the authorization grant, not the
      //   client: `consentReferenceId` returns the picked connectionId
      //   (read from the D1 selection seam — the callback cannot see the
      //   OAuth query, so `getOAuthProviderState()` recovers it), and
      //   `customAccessTokenClaims` stamps it as the `${base}/connection`
      //   claim. No grant ⇒ no claim ⇒ 403 (fail closed).
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/consent",
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        validAudiences: [`${runtime.BETTER_AUTH_URL}/mcp`],
        accessTokenExpiresIn: 900,
        postLogin: {
          page: "/connect/select",
          // Redirect to the picker until a Connection is selected for
          // THIS in-flight authorization request. No query (cannot
          // recover the handshake) → don't loop; fall through to a
          // claimless token → 403.
          shouldRedirect: async ({ user }) => {
            const state = await getOAuthProviderState();
            if (state?.query === undefined) return false;
            const picked = await readSelection(
              connectControlDb(env.DB),
              state.query,
              user.id,
            );
            return picked === undefined;
          },
          // Read (never delete — fires more than once per flow) the
          // picked Connection. Undefined ⇒ no reference ⇒ no claim ⇒
          // 403, consistent with the mandatory invariant. Also re-verify
          // membership against the Connection's org at THIS instant so
          // a user removed from the org between picker and consent
          // doesn't get a signed-but-inert token (resolveConnection
          // would later reject it at /mcp). Issuing a token whose
          // membership has already lapsed is a worse UX than failing
          // closed in the consent flow itself.
          consentReferenceId: async ({ user }) => {
            const state = await getOAuthProviderState();
            if (state?.query === undefined) return undefined;
            const db = connectControlDb(env.DB);
            const picked = await readSelection(db, state.query, user.id);
            if (picked === undefined) return undefined;
            const ref = await resolveConnection(db, {
              userId: user.id,
              connectionId: picked,
            });
            return ref === undefined ? undefined : picked;
          },
        },
        customAccessTokenClaims: ({ referenceId }): Record<string, string> =>
          referenceId === undefined || referenceId === ""
            ? {}
            : { [connectionClaimKey(runtime.BETTER_AUTH_URL)]: referenceId },
      }),
      // Org plugin owns organization + member + invitation. Nicia owns
      // `project` (one ProjectStore DO per project — no Better Auth
      // concept), wired via organizationHooks. No plugin-level
      // `sendInvitationEmail`: the team server fn creates the invitation
      // first, then optionally sends fail-soft email. With
      // `requireEmailVerificationOnInvitation: false`, Better Auth still
      // binds acceptance to the invited email.
      organization({
        creatorRole: "owner",
        requireEmailVerificationOnInvitation: false,
        invitationExpiresIn: INVITATION_TTL_SECONDS,
        organizationHooks: {
          // Materialize the org's default project (the data-plane DO
          // self-heals lazily on first access).
          afterCreateOrganization: async ({ organization: org }) => {
            await materializeDefaultProject(
              connectControlDb(env.DB),
              asOrganizationId(org.id),
            );
          },
          // Member removed / role changed → bump every org project's
          // epoch so the in-isolate validation cache invalidates on the
          // next request (immediate revoke, not after the 45s TTL).
          afterRemoveMember: async ({ member: m }) => {
            await bumpOrgProjectsEpoch(
              connectControlDb(env.DB),
              asOrganizationId(m.organizationId),
            );
          },
          afterUpdateMemberRole: async ({ member: m }) => {
            await bumpOrgProjectsEpoch(
              connectControlDb(env.DB),
              asOrganizationId(m.organizationId),
            );
          },
          // Tear down the org's ProjectStore DO storage BEFORE Better
          // Auth deletes the organization row (which cascade-deletes the
          // `project` rows, after which there'd be no ids to purge).
          beforeDeleteOrganization: async ({ organization: org }) => {
            await purgeOrgProjects(
              env,
              connectControlDb(env.DB),
              asOrganizationId(org.id),
            );
          },
        },
      }),
      // Site administration: role-gated user/org visibility + management
      // (ban, set-role, impersonate, revoke sessions). Gates purely on
      // role="admin"; the first admin is bootstrapped by the ADMIN_EMAILS
      // databaseHook above, then promotes others via setRole. Defaults:
      // defaultRole "user", adminRoles ["admin"].
      admin({
        impersonationSessionDuration: 60 * 60,
      }),
    ],
  });
}

export function getAuth(env: Env): ReturnType<typeof create> {
  const runtime = resolveServerEnv(env);
  // The Google creds change the plugin surface, so they belong in the key:
  // toggling them (or rotating the secret) must rebuild the cached instance.
  const key = [
    runtime.BETTER_AUTH_SECRET,
    runtime.BETTER_AUTH_URL,
    runtime.google?.clientId ?? "",
    runtime.google?.clientSecret ?? "",
    runtime.adminEmails.join(","),
  ].join(":");
  if (cachedAuth === undefined || cachedKey !== key) {
    cachedAuth = create(env, runtime);
    cachedKey = key;
  }
  return cachedAuth;
}
