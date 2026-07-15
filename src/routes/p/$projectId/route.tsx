import {
  createFileRoute,
  Outlet,
  redirect,
  useMatches,
} from "@tanstack/react-router";
import { Menu, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AccountCard } from "@/components/shell/AccountCard";
import { SidebarNav } from "@/components/shell/SidebarNav";
import { useDialogFocusTrap } from "@/components/ui/dialog-focus";
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
  const navCloseRef = useRef<HTMLButtonElement>(null);
  const mobileNavRef = useDialogFocusTrap({
    open: navOpen,
    onClose: () => setNavOpen(false),
    initialFocus: navCloseRef,
  });

  // Per-page ground: data-dense pages keep the slate-50 desk so their white
  // cards read; the single-document surface (read/edit AND the new-document
  // composer) gets a white ground so the borderless document is the open
  // white figure (see DESIGN.md figure/ground).
  const onDocumentSurface = useMatches().some(
    (m) =>
      m.routeId === "/p/$projectId/documents/$slug/" ||
      m.routeId === "/p/$projectId/documents/new",
  );

  // Attribute product events to the active organization so analytics can
  // segment by org (per-org funnels, retention, expansion).
  useEffect(() => {
    setOrganization({ id: orgId, name: orgName });
  }, [orgId, orgName]);

  useEffect(() => {
    if (!navOpen) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [navOpen]);

  const sidebarContent = (onNavigate?: () => void): React.ReactNode => (
    <>
      <OrgProjectSwitcher shell={shell} projectId={projectId} />
      <SidebarNav
        projectId={projectId}
        isOwner={isOwner}
        {...(onNavigate === undefined ? {} : { onNavigate })}
      />
      <div className="mt-auto">
        <AccountCard
          user={shell.user}
          support={shell.support}
          docs={shell.docs}
        />
      </div>
    </>
  );

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
          aria-controls="mobile-primary-sidebar"
          onClick={() => setNavOpen(true)}
          className="grid size-11 place-items-center rounded-md text-slate-600 hover:bg-slate-50 hover:text-slate-900"
        >
          <Menu className="size-5" />
        </button>
        <Wordmark />
      </div>
      {navOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setNavOpen(false)}
            className="absolute inset-0 bg-slate-900/40"
          />
          <aside
            ref={mobileNavRef}
            id="mobile-primary-sidebar"
            role="dialog"
            aria-modal="true"
            aria-label="Primary navigation"
            className="relative z-10 flex h-full w-72 max-w-[calc(100vw-3rem)] flex-col border-r border-slate-200 bg-slate-100 px-3 pt-[max(1.25rem,env(safe-area-inset-top))] pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-sm"
          >
            <div className="mb-7 flex items-center justify-between gap-3 px-2">
              <Wordmark />
              <button
                ref={navCloseRef}
                type="button"
                aria-label="Close navigation"
                onClick={() => setNavOpen(false)}
                className="grid size-11 place-items-center rounded-md text-slate-600 hover:bg-slate-200 hover:text-slate-900"
              >
                <X className="size-5" aria-hidden="true" />
              </button>
            </div>
            {sidebarContent(() => setNavOpen(false))}
          </aside>
        </div>
      )}
      <aside className="hidden w-48 shrink-0 flex-col border-r border-slate-200 bg-slate-100 px-3 py-5 md:flex">
        <div className="mb-7 px-2">
          <Wordmark />
        </div>
        {sidebarContent()}
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
