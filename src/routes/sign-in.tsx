import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";

import { Field } from "@/components/Field";
import { GoogleSignInButton } from "@/components/GoogleSignInButton";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { textLinkClass } from "@/components/ui/text-link";
import { track } from "@/lib/analytics";
import { authClient, isOAuthResume } from "@/lib/auth-client";
import { TAGLINE } from "@/lib/copy";
import { useSubmit } from "@/lib/forms";
import { getGoogleEnabled } from "@/lib/server/auth-config";

export const Route = createFileRoute("/sign-in")({
  component: SignIn,
  validateSearch: z.object({
    invite: z
      .string()
      .optional()
      .transform((s) => (s === undefined || s === "" ? undefined : s)),
  }),
  loader: (): Promise<{ googleEnabled: boolean }> => getGoogleEnabled(),
});

function SignIn() {
  const nav = useNavigate();
  const { invite } = Route.useSearch();
  const { googleEnabled } = Route.useLoaderData();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { pending, error, run } = useSubmit(async () => {
    const r = await authClient.signIn.email({ email, password });
    if (r.error) throw new Error(r.error.message ?? "Sign in failed");
    // Mid-OAuth: the client redirectPlugin is navigating into the
    // authorization flow — don't race it with an in-app nav.
    if (isOAuthResume(r.data)) return;
    track("signed_in", { method: "email" });
    await (invite
      ? nav({ to: "/invite/$invitationId", params: { invitationId: invite } })
      : nav({ to: "/" }));
  });
  return (
    <div>
      <PageHeader title="Sign in" subtitle={TAGLINE} />
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <Field label="Email" type="email" value={email} onChange={setEmail} />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
        />
        {error && <p className="text-base text-red-600">{error}</p>}
        <Button type="submit" disabled={pending} className="w-full">
          Sign in
        </Button>
      </form>
      {googleEnabled && (
        <GoogleSignInButton callbackURL={invite ? `/invite/${invite}` : "/"} />
      )}
      <p className="mt-4 text-base text-slate-500">
        No account?{" "}
        <Link
          to="/sign-up"
          search={invite !== undefined ? { invite } : {}}
          className={textLinkClass()}
        >
          Create one
        </Link>
      </p>
    </div>
  );
}
