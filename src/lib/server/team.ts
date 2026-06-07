import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { APIError } from "better-auth/api";
import { z } from "zod";

import { getAuth } from "@/auth";
import { asRole, type Role } from "@/control/access";
import { entitlementsOf } from "@/control/entitlements";
import { ForbiddenError } from "@/errors";
import {
  asInvitationId,
  asMemberId,
  asUserId,
  type InvitationId,
  type MemberId,
  type UserId,
} from "@/ids";
import { authMiddleware, projectMiddleware } from "@/lib/middleware";
import { assertServerContext as srv } from "@/lib/server-context";

export type { Role };

// Plain JSON DTOs (Better Auth return shapes carry inferred plugin
// types that don't satisfy TanStack's serializable constraint).
export type TeamMember = Readonly<{
  memberId: MemberId;
  userId: UserId;
  name: string;
  email: string;
  role: Role;
}>;
export type PendingInvite = Readonly<{
  invitationId: InvitationId;
  email: string;
  role: Role;
  expiresAt: string;
}>;
export type TeamData = Readonly<{
  members: readonly TeamMember[];
  invitations: readonly PendingInvite[];
  selfUserId: UserId;
  role: Role;
}>;
export type AcceptResult = Readonly<
  { ok: true } | { ok: false; reason: "invalid" | "not_recipient" }
>;
export type InviteSession = Readonly<
  { authed: false } | { authed: true; email: string | undefined }
>;

const ROLE = z.enum(["owner", "member"]);

// The org-plugin call surface, resolved once: every team server fn needs
// the auth API, the resolved org id (scoped strictly to the session —
// never client input), the request headers, and the acting role.
function authScope(context: unknown) {
  const c = srv(context);
  return {
    env: c.env,
    api: getAuth(c.env).api,
    organizationId: c.project?.organizationId ?? "",
    userId: c.project?.userId ?? "",
    role: c.project?.role ?? "member",
    headers: new Headers(getRequestHeaders()),
    entitlements: entitlementsOf(c),
  };
}

function requireOwner(role: Role): void {
  if (role !== "owner") {
    throw new ForbiddenError("Only an organization owner can manage the team");
  }
}

// One round-trip for the /team page: `getFullOrganization` returns
// members + invitations + the user join in a single call.
export const listTeam = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .handler(async ({ context }): Promise<TeamData> => {
    const { api, organizationId, headers, userId, role } = authScope(context);
    const org = await api.getFullOrganization({
      query: { organizationId },
      headers,
    });
    const members: TeamMember[] = (org?.members ?? []).map((m) => ({
      memberId: asMemberId(m.id),
      userId: asUserId(m.userId),
      name: m.user.name,
      email: m.user.email,
      role: asRole(m.role),
    }));
    const invitations: PendingInvite[] = (org?.invitations ?? [])
      .filter((i) => i.status === "pending")
      .map((i) => ({
        invitationId: asInvitationId(i.id),
        email: i.email,
        role: asRole(i.role),
        expiresAt:
          i.expiresAt instanceof Date
            ? i.expiresAt.toISOString()
            : String(i.expiresAt),
      }));
    return { members, invitations, selfUserId: asUserId(userId), role };
  });

// Create a pending invitation and return the shareable link. No email
// is sent (no infra) — the owner shares this URL out-of-band; Better
// Auth binds acceptance to the invited email.
export const inviteMember = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(z.object({ email: z.email(), role: ROLE }))
  .handler(
    async ({
      data,
      context,
    }): Promise<{ inviteUrl: string; email: string }> => {
      const { api, organizationId, headers, role, env, entitlements } =
        authScope(context);
      requireOwner(role);
      const c = srv(context);
      await entitlements.assertWithinQuota({
        action: "member_invite",
        userId: c.project?.userId,
        organizationId: c.project?.organizationId,
        projectId: c.project?.projectId,
        amount: 1,
      });
      const invitation = await api.createInvitation({
        body: { email: data.email, role: data.role, organizationId },
        headers,
      });
      return {
        inviteUrl: `${env.BETTER_AUTH_URL}/invite/${invitation.id}`,
        email: data.email,
      };
    },
  );

export const revokeInvitation = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(z.object({ invitationId: z.string().min(1) }))
  .handler(async ({ data, context }): Promise<{ ok: boolean }> => {
    const { api, headers, role } = authScope(context);
    requireOwner(role);
    await api.cancelInvitation({
      body: { invitationId: data.invitationId },
      headers,
    });
    return { ok: true };
  });

export const changeMemberRole = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(z.object({ memberId: z.string().min(1), role: ROLE }))
  .handler(async ({ data, context }): Promise<{ ok: boolean }> => {
    const { api, organizationId, headers, role } = authScope(context);
    requireOwner(role);
    await api.updateMemberRole({
      body: { memberId: data.memberId, role: data.role, organizationId },
      headers,
    });
    return { ok: true };
  });

export const removeMember = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(z.object({ memberIdOrEmail: z.string().min(1) }))
  .handler(async ({ data, context }): Promise<{ ok: boolean }> => {
    const { api, organizationId, headers, role } = authScope(context);
    requireOwner(role);
    await api.removeMember({
      body: { memberIdOrEmail: data.memberIdOrEmail, organizationId },
      headers,
    });
    return { ok: true };
  });

export const loadInviteSession = createServerFn({ method: "GET" }).handler(
  ({ context }): InviteSession => {
    const user = srv(context).authSession?.user;
    if (user === undefined) return { authed: false };
    return { authed: true, email: user.email };
  },
);

// Mirror of `ORGANIZATION_ERROR_CODES.YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION`
// from `better-auth/plugins/organization` — the constants module is not
// part of Better Auth's public package exports, so we name
// the one code we branch on locally. The library exposes a stable
// `body.code` (string key) alongside the human-readable `body.message`;
// we classify on the code so a future cosmetic message change in
// Better Auth doesn't silently fold not_recipient into "invalid". Any
// other rejection (expired / not-found / membership-limit /
// failed-retrieve) is folded into `"invalid"`; expiry in particular is
// intentionally not distinguishable because the library throws
// `INVITATION_NOT_FOUND` for it.
const BA_NOT_RECIPIENT_CODE = "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION";

export const acceptInvitation = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ invitationId: z.string().min(1) }))
  .handler(async ({ data, context }): Promise<AcceptResult> => {
    const { api, headers } = authScope(context);
    try {
      await api.acceptInvitation({
        body: { invitationId: data.invitationId },
        headers,
      });
      return { ok: true };
    } catch (err) {
      if (err instanceof APIError && err.body?.code === BA_NOT_RECIPIENT_CODE) {
        return { ok: false, reason: "not_recipient" };
      }
      return { ok: false, reason: "invalid" };
    }
  });
