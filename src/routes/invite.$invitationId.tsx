import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { Button, buttonStyles } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { asInvitationId } from "@/ids";
import { useSubmit } from "@/lib/forms";
import {
  acceptInvitation,
  type AcceptResult,
  loadInviteSession,
} from "@/lib/server/team.functions";

export const Route = createFileRoute("/invite/$invitationId")({
  component: Invite,
  loader: async () => loadInviteSession(),
});

type AcceptReason = Extract<AcceptResult, { ok: false }>["reason"];

const REASON_MESSAGE: Readonly<Record<AcceptReason, string>> = {
  not_recipient:
    "This invitation was sent to a different email. Sign in with the address it was sent to, then open this link again.",
  invalid: "This invitation is no longer valid.",
};

function Invite() {
  const session = Route.useLoaderData();
  const invitationId = asInvitationId(Route.useParams().invitationId);
  const nav = useNavigate();
  const [reason, setReason] = useState<AcceptReason>();

  const { pending, error, run } = useSubmit(async () => {
    const r = await acceptInvitation({ data: { invitationId } });
    if (r.ok) {
      // Full nav so every cached loader / auth-derived state is dropped
      // and the new membership resolves cleanly (mirrors sign-out).
      window.location.href = "/";
      return;
    }
    setReason(r.reason);
  });

  if (!session.authed) {
    return (
      <div>
        <PageHeader
          title="You’ve been invited"
          subtitle="Join your team’s canonical collection."
        />
        <p className="mb-4 text-base text-slate-600">
          Sign in (or create an account) with the email this invite was sent to.
          You&rsquo;ll join the team right after.
        </p>
        <div className="flex gap-3">
          <Link
            to="/sign-up"
            search={{ invite: invitationId }}
            className={buttonStyles()}
          >
            Create account
          </Link>
          <Link
            to="/sign-in"
            search={{ invite: invitationId }}
            className={buttonStyles("secondary")}
          >
            Sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Accept invitation"
        subtitle={`Signed in as ${session.email ?? "this account"}.`}
      />
      {reason !== undefined ? (
        <p className="mb-4 text-base text-amber-700">
          {REASON_MESSAGE[reason]}
        </p>
      ) : (
        <p className="mb-4 text-base text-slate-600">
          Accept to join the team. The invite must have been sent to{" "}
          {session.email ?? "this account"}.
        </p>
      )}
      <div className="flex gap-3">
        <Button disabled={pending} onClick={() => void run()}>
          Accept invitation
        </Button>
        <Button
          variant="secondary"
          disabled={pending}
          onClick={() => void nav({ to: "/" })}
        >
          Not now
        </Button>
      </div>
      {error && <p className="mt-3 text-base text-red-600">{error}</p>}
    </div>
  );
}
