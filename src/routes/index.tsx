import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { Field } from "@/components/Field";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { TAGLINE } from "@/lib/copy";
import { useSubmit } from "@/lib/forms";
import { createOrganization, resolveLanding } from "@/lib/server/session";

// The project-less landing: resolves server-side to sign-in (no
// session), the first-run form (no project yet), or the user's default
// project at `/p/<projectId>` — so a single-project user keeps a clean
// top-level URL and never types a project id.
export const Route = createFileRoute("/")({
  component: FirstRunPage,
  loader: async (): Promise<{ firstRun: true }> => {
    const r = await resolveLanding();
    if (!r.authed) throw redirect({ to: "/sign-in" });
    if (!r.firstRun) {
      throw redirect({
        to: "/p/$projectId",
        params: { projectId: r.projectId },
      });
    }
    return { firstRun: true };
  },
});

function FirstRunPage() {
  const router = useRouter();
  return <FirstRun onDone={() => void router.invalidate()} />;
}

// No organization yet. Creating one materializes the org's default
// project; invalidating re-runs the loader, which now resolves a project
// and redirects to `/p/<slug>`. The outer surface comes from
// __root.tsx's pre-project centered panel — peer pages (sign-in,
// sign-up, invite, connect.select) share it, so we don't wrap again.
function FirstRun({ onDone }: Readonly<{ onDone: () => void }>) {
  const [name, setName] = useState("");
  const { pending, error, run } = useSubmit(async () => {
    await createOrganization({ data: { name } });
    onDone();
  });
  return (
    <>
      <PageHeader title="Name your organization" subtitle={TAGLINE} />
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <Field label="Organization name" value={name} onChange={setName} />
        {error && <p className="text-base text-red-600">{error}</p>}
        <Button type="submit" disabled={pending} className="w-full">
          Create organization
        </Button>
      </form>
    </>
  );
}
