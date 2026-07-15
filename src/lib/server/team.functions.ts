import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { Role } from "@/control/access";
import type { SendEmailResult } from "@/control/email.server";
import type { InvitationId, MemberId, UserId } from "@/ids";
import { authMiddleware, projectMiddleware } from "@/lib/middleware";

import {
  acceptInvitationImpl,
  changeMemberRoleImpl,
  inviteMemberImpl,
  listTeamImpl,
  loadInviteSessionImpl,
  removeMemberImpl,
  revokeInvitationImpl,
} from "./team.server";

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
export type InviteEmailReason = Exclude<
  SendEmailResult,
  { sent: true }
>["reason"];
export type InviteMemberResult = Readonly<{
  inviteUrl: string;
  email: string;
  emailSent: boolean;
  emailReason?: InviteEmailReason;
}>;

const ROLE = z.enum(["owner", "member"]);

// One round-trip for the /team page: `getFullOrganization` returns
// members + invitations + the user join in a single call.
export const listTeam = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .handler(({ context }): Promise<TeamData> => listTeamImpl(context));

// Create a pending invitation, then try to send the link. Email is
// fail-soft: Better Auth owns the invitation row and acceptance binding,
// and the owner still gets the URL when sending is unavailable.
export const inviteMember = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(z.object({ email: z.email(), role: ROLE }))
  .handler(({ data, context }): Promise<InviteMemberResult> =>
    inviteMemberImpl(data, context),
  );

export const revokeInvitation = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(z.object({ invitationId: z.string().min(1) }))
  .handler(({ data, context }): Promise<{ ok: boolean }> =>
    revokeInvitationImpl(data.invitationId, context),
  );

export const changeMemberRole = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(z.object({ memberId: z.string().min(1), role: ROLE }))
  .handler(({ data, context }): Promise<{ ok: boolean }> =>
    changeMemberRoleImpl(data, context),
  );

export const removeMember = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(z.object({ memberIdOrEmail: z.string().min(1) }))
  .handler(({ data, context }): Promise<{ ok: boolean }> =>
    removeMemberImpl(data.memberIdOrEmail, context),
  );

export const loadInviteSession = createServerFn({ method: "GET" }).handler(
  ({ context }): InviteSession => loadInviteSessionImpl(context),
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
export const acceptInvitation = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ invitationId: z.string().min(1) }))
  .handler(({ data, context }): Promise<AcceptResult> =>
    acceptInvitationImpl(data.invitationId, context),
  );
