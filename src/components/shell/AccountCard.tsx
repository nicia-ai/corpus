import { Link } from "@tanstack/react-router";
import { BookOpen, LifeBuoy, LogOut, ShieldCheck } from "lucide-react";

import { SidebarLinkItem } from "@/components/shell/SidebarLinkItem";
import type { SidebarLink } from "@/control/env";
import { authClient } from "@/lib/auth-client";
import type { ProjectShell } from "@/lib/server/session";

// Initials for the account avatar: first letters of a display name, else
// the email's local part. Always uppercased, max two glyphs.
function initials(nameOrEmail: string): string {
  const base = nameOrEmail.split("@")[0] ?? nameOrEmail;
  const parts = base.split(/[ ._-]+/).filter(Boolean);
  const a = parts[0] ?? "";
  const b = parts[1] ?? "";
  const picked = b !== "" ? `${a[0] ?? ""}${b[0] ?? ""}` : base.slice(0, 2);
  return (picked === "" ? "?" : picked).toUpperCase();
}

// Sidebar footer: avatar (initials), name, email, sign-out icon.
// Sign-out is a full-page nav (not the SPA router) on purpose: it drops
// every cached loader result and auth-derived state so no stale project
// data survives the sign-out.
export function AccountCard({
  user,
  support,
  docs,
}: Readonly<{
  user: ProjectShell["user"];
  support: SidebarLink | null;
  docs: SidebarLink | null;
}>): React.ReactElement {
  const display = user.name ?? user.email ?? "";
  // Platform-admin link — shown only to admins (user.role === "admin").
  // The bootstrap admin is given that role at signup (ADMIN_EMAILS); others via setRole.
  // Org "owner" never sees this; it's product-wide, not org-scoped.
  const { data } = authClient.useSession();
  const isAdmin = data?.user.role === "admin";

  return (
    <div className="border-t border-slate-200 pt-3">
      {docs && <SidebarLinkItem link={docs} icon={BookOpen} />}
      {support && <SidebarLinkItem link={support} icon={LifeBuoy} />}
      {isAdmin && (
        <Link
          to="/admin"
          className="mb-1 flex min-h-11 items-center gap-2.5 rounded-md px-2 py-2 text-base font-medium text-slate-600 hover:bg-slate-200 hover:text-slate-900"
        >
          <ShieldCheck className="size-4 shrink-0" />
          Admin
        </Link>
      )}
      <div className="flex items-center gap-3 rounded-md px-2 py-2">
        <div
          aria-hidden
          className="grid size-8 shrink-0 place-items-center rounded-md bg-slate-200 text-sm font-semibold tabular-nums text-slate-600"
        >
          {initials(display)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-medium text-slate-900">
            {user.name ?? "Signed in"}
          </div>
          <div className="truncate text-sm text-slate-600">
            {user.email ?? ""}
          </div>
        </div>
        <button
          type="button"
          aria-label="Sign out"
          title="Sign out"
          onClick={() => {
            void authClient.signOut().finally(() => {
              window.location.href = "/sign-in";
            });
          }}
          className="grid size-11 shrink-0 place-items-center rounded-md text-slate-500 hover:bg-slate-200 hover:text-slate-900"
        >
          <LogOut className="size-4" />
        </button>
      </div>
    </div>
  );
}
