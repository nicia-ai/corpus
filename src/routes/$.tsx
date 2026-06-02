import { createFileRoute, redirect } from "@tanstack/react-router";

import { resolveLanding } from "@/lib/server/session";

// Catch-all for unknown top-level paths. Explicit routes win over this
// splat, so it only fires for paths that match nothing else; it resolves
// the user's default project server-side and redirects into the
// canonical project-scoped URL (or sign-in when unauthed), preserving
// sub-path + query.
export const Route = createFileRoute("/$")({
  loader: async ({ params, location }) => {
    const tail = params._splat ?? "";
    const r = await resolveLanding();
    if (!r.authed) throw redirect({ to: "/sign-in" });
    if (r.firstRun) throw redirect({ to: "/" });
    const suffix = tail === "" ? "" : `/${tail}`;
    throw redirect({
      href: `/p/${r.projectId}${suffix}${location.searchStr}`,
    });
  },
});
