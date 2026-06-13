import {
  createFileRoute,
  getRouteApi,
  useRouter,
} from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { useState } from "react";

import { Field } from "@/components/Field";
import { Button } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState, listSurface } from "@/components/ui/Surface";
import { asProjectId, type ProjectId } from "@/ids";
import { track } from "@/lib/analytics";
import { useSubmit } from "@/lib/forms";
import {
  changeMemberRole,
  inviteMember,
  listTeam,
  type InviteMemberResult,
  type PendingInvite,
  removeMember,
  revokeInvitation,
  type Role,
  type TeamMember,
} from "@/lib/server/team";

function RoleSelect({
  value,
  disabled,
  ariaLabel,
  onChange,
}: Readonly<{
  value: Role;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (role: Role) => void;
}>) {
  // Native <select> styled to match the design-system text input
  // (Field): same slate-300 border, md radius, padding, base size and
  // blue focus ring, with the OS chevron replaced by an on-system icon
  // so it aligns with the input + button it sits beside in the invite row.
  return (
    <div className="relative inline-block">
      <select
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as Role)}
        className="appearance-none rounded-md border border-slate-300 bg-white py-2 pl-3 pr-9 text-base focus:border-blue-600 focus:outline-2 focus:outline-blue-600 disabled:opacity-50"
      >
        <option value="member">member</option>
        <option value="owner">owner</option>
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-slate-400"
      />
    </div>
  );
}

export const Route = createFileRoute("/p/$projectId/team")({
  component: Team,
  loader: async ({ params }) =>
    listTeam({ data: { projectId: params.projectId } }),
});

const layout = getRouteApi("/p/$projectId");

function Team() {
  const data = Route.useLoaderData();
  const { orgName } = layout.useLoaderData().current;
  const projectId = asProjectId(Route.useParams().projectId);
  const router = useRouter();
  const isOwner = data.role === "owner";
  const ownerCount = data.members.filter((m) => m.role === "owner").length;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={`${orgName} Team`}
        subtitle="Everyone here shares this organization’s canonical collections."
      />

      <h2 className="mb-2 text-base font-medium text-slate-700">Members</h2>
      <ul className={listSurface("mb-8 divide-y divide-slate-200")}>
        {data.members.map((m) => (
          <MemberRow
            key={m.memberId}
            member={m}
            projectId={projectId}
            isOwner={isOwner}
            isSelf={m.userId === data.selfUserId}
            soleOwner={m.role === "owner" && ownerCount === 1}
            onChanged={() => void router.invalidate()}
          />
        ))}
      </ul>

      {isOwner && (
        <>
          <h2 className="mb-2 text-base font-medium text-slate-700">
            Invite a teammate
          </h2>
          <InviteForm
            projectId={projectId}
            onInvited={() => void router.invalidate()}
          />

          <h2 className="mt-8 mb-2 text-base font-medium text-slate-700">
            Pending invitations
          </h2>
          {data.invitations.length === 0 ? (
            <EmptyState>
              No pending invitations. Invite a teammate above to share this
              org&rsquo;s collections.
            </EmptyState>
          ) : (
            <ul className={listSurface("divide-y divide-slate-200")}>
              {data.invitations.map((i) => (
                <InviteRow
                  key={i.invitationId}
                  invite={i}
                  projectId={projectId}
                  onRevoked={() => void router.invalidate()}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function MemberRow({
  member,
  projectId,
  isOwner,
  isSelf,
  soleOwner,
  onChanged,
}: Readonly<{
  member: TeamMember;
  projectId: ProjectId;
  isOwner: boolean;
  isSelf: boolean;
  soleOwner: boolean;
  onChanged: () => void;
}>) {
  const { pending, error, run } = useSubmit(
    async (fn: () => Promise<{ ok: boolean }>) => {
      const r = await fn();
      if (!r.ok) throw new Error("That didn’t take — please retry.");
      onChanged();
    },
  );
  return (
    <li className="flex items-center gap-3 px-3 py-3 text-base">
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-slate-900">
          {member.name || member.email}
        </span>
        {member.name !== "" && (
          <span className="block truncate text-sm text-slate-500">
            {member.email}
          </span>
        )}
      </span>
      {isOwner && !isSelf ? (
        <RoleSelect
          ariaLabel={`Role for ${member.email}`}
          value={member.role}
          disabled={pending || soleOwner}
          onChange={(role) =>
            void run(() =>
              changeMemberRole({
                data: { projectId, memberId: member.memberId, role },
              }),
            )
          }
        />
      ) : (
        <span className="rounded-md bg-slate-100 px-2 py-0.5 text-sm text-slate-600">
          {member.role}
        </span>
      )}
      {isOwner && !isSelf && (
        <button
          type="button"
          disabled={pending}
          aria-label={`Remove ${member.email}`}
          title="Remove"
          onClick={() =>
            void run(() =>
              removeMember({
                data: { projectId, memberIdOrEmail: member.memberId },
              }),
            )
          }
          className="shrink-0 rounded-md px-2 py-1 text-sm text-slate-400 hover:bg-slate-50 hover:text-amber-700 disabled:opacity-50"
        >
          Remove
        </button>
      )}
      {error && <span className="text-sm text-red-600">{error}</span>}
    </li>
  );
}

function InviteForm({
  projectId,
  onInvited,
}: Readonly<{ projectId: ProjectId; onInvited: () => void }>) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [lastInvite, setLastInvite] = useState<InviteMemberResult>();
  const { pending, error, run } = useSubmit(async () => {
    setLastInvite(undefined);
    const r = await inviteMember({
      data: { projectId, email: email.trim(), role },
    });
    track("member_invited", { projectId, role });
    setLastInvite(r);
    setEmail("");
    onInvited();
  });
  return (
    <div className="mb-2 space-y-3">
      <form
        className="flex items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <div className="flex-1">
          <Field label="Email" type="email" value={email} onChange={setEmail} />
        </div>
        <RoleSelect ariaLabel="Invite role" value={role} onChange={setRole} />
        <Button type="submit" disabled={pending}>
          Create invite
        </Button>
      </form>
      {error && <p className="text-base text-red-600">{error}</p>}
      {lastInvite !== undefined && <InviteResult invite={lastInvite} />}
    </div>
  );
}

// The link is shown a single time, so it stays copyable on every outcome —
// even a "sent" report only means the provider accepted the message, not that
// it was delivered. Email success just changes the framing and tone.
function InviteResult({
  invite,
}: Readonly<{ invite: InviteMemberResult }>): React.ReactElement {
  const note = invite.emailSent
    ? `Invite emailed to ${invite.email}. Keep this link as a backup.`
    : invite.emailReason === "send-failed"
      ? "Email could not be sent — share this link yourself."
      : "Email is not configured — share this link yourself.";
  const tone = invite.emailSent
    ? "border-emerald-200 bg-emerald-50 text-emerald-900"
    : "border-slate-200 bg-white text-slate-700";
  return (
    <div className={`rounded-md border p-3 text-sm ${tone}`}>
      <p className="mb-2 font-medium">
        {note} They must sign up with the invited email.
      </p>
      <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 p-2">
        <code className="min-w-0 flex-1 truncate font-mono text-slate-700">
          {invite.inviteUrl}
        </code>
        <CopyButton value={invite.inviteUrl} label="Copy invite link" />
      </div>
    </div>
  );
}

function InviteRow({
  invite,
  projectId,
  onRevoked,
}: Readonly<{
  invite: PendingInvite;
  projectId: ProjectId;
  onRevoked: () => void;
}>) {
  const { pending, error, run } = useSubmit(async () => {
    const r = await revokeInvitation({
      data: { projectId, invitationId: invite.invitationId },
    });
    if (!r.ok) throw new Error("Could not revoke — please retry.");
    onRevoked();
  });
  return (
    <li className="flex items-center gap-3 px-3 py-3 text-base">
      <span className="flex-1 truncate text-slate-900">{invite.email}</span>
      <span className="rounded-md bg-slate-100 px-2 py-0.5 text-sm text-slate-600">
        {invite.role}
      </span>
      <button
        type="button"
        disabled={pending}
        onClick={() => void run()}
        className="shrink-0 rounded-md px-2 py-1 text-sm text-slate-400 hover:bg-slate-50 hover:text-amber-700 disabled:opacity-50"
      >
        Revoke
      </button>
      {error && <span className="text-sm text-red-600">{error}</span>}
    </li>
  );
}
