import {
  createFileRoute,
  Outlet,
  redirect,
  useMatches,
} from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { useEffect, useState } from "react";

import { AccountCard } from "@/components/shell/AccountCard";
import { SidebarNav } from "@/components/shell/SidebarNav";
import { Wordmark } from "@/components/ui/Wordmark";
import { OrgProjectSwitcher } from "@/features/shell/OrgProjectSwitcher";
import { asProjectId } from "@/ids";
import { setOrganization } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import { loadProjectShell } from "@/lib/server/session";

export const Route = createFileRoute("/p/$projectId")({
  component: ProjectLayout,
  loader: async ({ params }) => {
    const shell = await loadProjectShell({
      data: { projectId: params.projectId },
    });
    // Not a project this session may reach (signed out, not a member,
    // broken/deleted, or a guessed id) → bounce to the resolver, which
    // sends the user to their own default project or sign-in. Never
    // reveal whether the id exists.
    if (!shell.ok) throw redirect({ to: "/" });
    return shell;
  },
});

function ProjectLayout() {
  const projectId = asProjectId(Route.useParams().projectId);
  const shell = Route.useLoaderData();
  const isOwner = shell.current.role === "owner";
  const { orgId, orgName } = shell.current;
  // Mobile-only off-canvas drawer state; md+ keeps the sidebar in flow.
  const [navOpen, setNavOpen] = useState(false);

  // Per-page ground: data-dense pages keep the slate-50 desk so their white
  // cards read; the single-document surface gets a white ground so the
  // borderless document is the open white figure (see DESIGN.md figure/ground).
  const onDocumentSurface = useMatches().some(
    (m) => m.routeId === "/p/$projectId/documents/$slug/",
  );

  // Attribute product events to the active organization so analytics can
  // segment by org (per-org funnels, retention, expansion).
  useEffect(() => {
    setOrganization({ id: orgId, name: orgName });
  }, [orgId, orgName]);

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      {/* The mobile bar is the burger only — the wordmark lives inside
          the sidebar (and the open drawer reveals it), so we don't show
          it twice on phones. */}
      <div className="flex items-center gap-2.5 border-b border-slate-200 bg-white px-4 py-3 md:hidden">
        <button
          type="button"
          aria-label="Open navigation"
          aria-expanded={navOpen}
          aria-controls="primary-sidebar"
          onClick={() => setNavOpen(true)}
          className="grid size-9 place-items-center rounded-md text-slate-600 hover:bg-slate-50 hover:text-slate-900"
        >
          <Menu className="size-5" />
        </button>
        <Wordmark />
      </div>
      {navOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setNavOpen(false)}
          className="fixed inset-0 z-40 bg-slate-900/40 md:hidden"
        />
      )}
      <aside
        id="primary-sidebar"
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-slate-200 bg-slate-100 px-3 py-5 transition-transform duration-200 ease-out motion-reduce:transition-none md:static md:z-auto md:w-48 md:shrink-0 md:translate-x-0",
          navOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="mb-7 px-2">
          <Wordmark />
        </div>
        <OrgProjectSwitcher shell={shell} projectId={projectId} />
        <SidebarNav
          projectId={projectId}
          isOwner={isOwner}
          onNavigate={() => setNavOpen(false)}
        />
        <div className="mt-auto">
          <AccountCard
            user={shell.user}
            support={shell.support}
            docs={shell.docs}
          />
        </div>
      </aside>
      <main
        className={cn(
          "flex-1 px-5 py-6 md:px-8 md:py-8",
          onDocumentSurface && "bg-white",
        )}
      >
        <div className="mx-auto max-w-7xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
