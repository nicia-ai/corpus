import { getRequestHeaders } from "@tanstack/react-start/server";
import { APIError } from "better-auth/api";

import { getAuth } from "@/auth.server";
import { asRole, type Role } from "@/control/access";
import {
  type EmailMessage,
  sendEmail,
  type SendEmailResult,
} from "@/control/email.server";
import { entitlementsOf } from "@/control/entitlements";
import { ForbiddenError } from "@/errors";
import { asInvitationId, asMemberId, asUserId } from "@/ids";
import type {
  AcceptResult,
  InviteMemberResult,
  InviteSession,
  PendingInvite,
  TeamData,
  TeamMember,
} from "@/lib/server/team.functions";
import { assertServerContext as srv } from "@/lib/server-context";
import { compact } from "@/util";

type InvitationApi = Readonly<{
  createInvitation: (args: {
    body: { email: string; role: Role; organizationId: string };
    headers: Headers;
  }) => Promise<{ id: string }>;
}>;

type InviteMailer = (
  env: Readonly<Env>,
  message: EmailMessage,
) => Promise<SendEmailResult>;
type InviteEmailContent = Omit<EmailMessage, "to">;

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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inviteEmail(inviteUrl: string): InviteEmailContent {
  const safeUrl = escapeHtml(inviteUrl);
  return {
    subject: "You have been invited to Corpus",
    html: `<p>You have been invited to join a Corpus team.</p><p><a href="${safeUrl}">Accept invitation</a></p><p>If the button does not work, copy and paste this link:</p><p><code>${safeUrl}</code></p>`,
    text: `You have been invited to join a Corpus team.\n\nAccept the invitation:\n${inviteUrl}\n`,
  };
}

export async function createTeamInvitation(
  args: Readonly<{
    api: InvitationApi;
    headers: Headers;
    organizationId: string;
    env: Readonly<Env>;
    email: string;
    role: Role;
    mailer?: InviteMailer;
  }>,
): Promise<InviteMemberResult> {
  const invitation = await args.api.createInvitation({
    body: {
      email: args.email,
      role: args.role,
      organizationId: args.organizationId,
    },
    headers: args.headers,
  });
  const inviteUrl = `${args.env.BETTER_AUTH_URL}/invite/${invitation.id}`;
  const send = await (args.mailer ?? sendEmail)(args.env, {
    to: args.email,
    ...inviteEmail(inviteUrl),
  });
  return compact({
    inviteUrl,
    email: args.email,
    emailSent: send.sent,
    emailReason: send.sent ? undefined : send.reason,
  });
}

export async function listTeamImpl(context: unknown): Promise<TeamData> {
  const { api, organizationId, headers, userId, role } = authScope(context);
  const org = await api.getFullOrganization({
    query: { organizationId },
    headers,
  });
  const members: TeamMember[] = (org?.members ?? []).map((member) => ({
    memberId: asMemberId(member.id),
    userId: asUserId(member.userId),
    name: member.user.name,
    email: member.user.email,
    role: asRole(member.role),
  }));
  const invitations: PendingInvite[] = (org?.invitations ?? [])
    .filter((invitation) => invitation.status === "pending")
    .map((invitation) => ({
      invitationId: asInvitationId(invitation.id),
      email: invitation.email,
      role: asRole(invitation.role),
      expiresAt:
        invitation.expiresAt instanceof Date
          ? invitation.expiresAt.toISOString()
          : String(invitation.expiresAt),
    }));
  return { members, invitations, selfUserId: asUserId(userId), role };
}

export async function inviteMemberImpl(
  data: Readonly<{ email: string; role: Role }>,
  context: unknown,
): Promise<InviteMemberResult> {
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
  return createTeamInvitation({
    api,
    headers,
    organizationId,
    env,
    email: data.email,
    role: data.role,
  });
}

export async function revokeInvitationImpl(
  invitationId: string,
  context: unknown,
): Promise<{ ok: boolean }> {
  const { api, headers, role } = authScope(context);
  requireOwner(role);
  await api.cancelInvitation({ body: { invitationId }, headers });
  return { ok: true };
}

export async function changeMemberRoleImpl(
  data: Readonly<{ memberId: string; role: Role }>,
  context: unknown,
): Promise<{ ok: boolean }> {
  const { api, organizationId, headers, role } = authScope(context);
  requireOwner(role);
  await api.updateMemberRole({
    body: { memberId: data.memberId, role: data.role, organizationId },
    headers,
  });
  return { ok: true };
}

export async function removeMemberImpl(
  memberIdOrEmail: string,
  context: unknown,
): Promise<{ ok: boolean }> {
  const { api, organizationId, headers, role } = authScope(context);
  requireOwner(role);
  await api.removeMember({
    body: { memberIdOrEmail, organizationId },
    headers,
  });
  return { ok: true };
}

export function loadInviteSessionImpl(context: unknown): InviteSession {
  const user = srv(context).authSession?.user;
  if (user === undefined) return { authed: false };
  return { authed: true, email: user.email };
}

const BA_NOT_RECIPIENT_CODE = "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION";

export async function acceptInvitationImpl(
  invitationId: string,
  context: unknown,
): Promise<AcceptResult> {
  const { api, headers } = authScope(context);
  try {
    await api.acceptInvitation({ body: { invitationId }, headers });
    return { ok: true };
  } catch (error) {
    if (
      error instanceof APIError &&
      error.body?.code === BA_NOT_RECIPIENT_CODE
    ) {
      return { ok: false, reason: "not_recipient" };
    }
    return { ok: false, reason: "invalid" };
  }
}
