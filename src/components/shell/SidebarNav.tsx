import { Link, useMatchRoute } from "@tanstack/react-router";
import {
  FileText,
  History,
  type LucideIcon,
  Settings,
  Users,
} from "lucide-react";

import type { ProjectId } from "@/ids";

// The project-scoped primary nav entries. Each `to` is the full route
// path; the active project id is supplied from the URL at render.
// Credentials (OAuth + API keys) live on the
// per-Corpus Connect setup panel — a key has no meaning outside a
// Connection (Project + one Corpus), so there is no project-wide
// "API keys" or "MCP" nav slot. The Connect button on each Corpus
// page is the entry point;
// `/connectors/mcp/setup?corpus=<slug>` is where it lands.
type NavEntry = Readonly<{
  to: string;
  label: string;
  icon: LucideIcon;
  ownerOnly?: boolean;
  // Routes that live under this entry in the product model but not in
  // the URL tree (a corpus page is part of Corpora).
  alsoActiveUnder?: readonly string[];
}>;

const NAV: readonly NavEntry[] = [
  {
    to: "/p/$projectId/documents",
    label: "Corpora",
    icon: FileText,
    alsoActiveUnder: ["/p/$projectId/corpora", "/p/$projectId/connectors"],
  },
  { to: "/p/$projectId/activity", label: "Activity", icon: History },
  { to: "/p/$projectId/team", label: "Team", icon: Users },
  {
    to: "/p/$projectId/settings",
    label: "Settings",
    icon: Settings,
    ownerOnly: true,
  },
];

export function SidebarNav({
  projectId,
  isOwner,
  onNavigate,
}: Readonly<{
  projectId: ProjectId;
  isOwner: boolean;
  onNavigate?: () => void;
}>): React.ReactElement {
  const matchRoute = useMatchRoute();
  const isActive = (entry: NavEntry): boolean =>
    [entry.to, ...(entry.alsoActiveUnder ?? [])].some(
      (to) => matchRoute({ to, params: { projectId }, fuzzy: true }) !== false,
    );
  return (
    <nav aria-label="Primary" className="space-y-0.5">
      {NAV.filter((n) => !n.ownerOnly || isOwner).map((n) => {
        const Icon = n.icon;
        const active = isActive(n);
        return (
          <Link
            key={n.to}
            to={n.to}
            params={{ projectId }}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={
              active
                ? "flex min-h-11 items-center gap-3 rounded-md bg-blue-50 px-3 py-2 text-base font-medium text-blue-700"
                : "flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-base text-slate-600 hover:bg-slate-200 hover:text-slate-900"
            }
          >
            <Icon className="size-4 shrink-0" />
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}
