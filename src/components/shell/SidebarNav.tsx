import { Link } from "@tanstack/react-router";
import {
  FileText,
  History,
  House,
  type LucideIcon,
  Settings,
  Share2,
  Users,
} from "lucide-react";

import type { ProjectId } from "@/ids";

// The project-scoped primary nav entries. Each `to` is the full route
// path; the active project id is supplied from the URL at render. Home
// is the project graph (one document feeding many agents); Share2
// echoes the fan-out. Credentials (OAuth + API keys) live on the
// per-Collection Connect setup panel — a key has no meaning outside a
// Connection (Project + one Collection), so there is no project-wide
// "API keys" or "MCP" nav slot. The Connect button on each Collection
// page is the entry point;
// `/connectors/mcp/setup?collection=<slug>` is where it lands.
type NavEntry = Readonly<{
  to: string;
  label: string;
  icon: LucideIcon;
  ownerOnly?: boolean;
}>;

const NAV: readonly NavEntry[] = [
  { to: "/p/$projectId", label: "Home", icon: House },
  { to: "/p/$projectId/collections", label: "Collections", icon: Share2 },
  { to: "/p/$projectId/documents", label: "Documents", icon: FileText },
  { to: "/p/$projectId/changes", label: "Changes", icon: History },
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
  return (
    <nav aria-label="Primary" className="space-y-0.5">
      {NAV.filter((n) => !n.ownerOnly || isOwner).map((n) => {
        const Icon = n.icon;
        return (
          <Link
            key={n.to}
            to={n.to}
            params={{ projectId }}
            onClick={onNavigate}
            activeOptions={{ exact: n.to === "/p/$projectId" }}
            activeProps={{
              className:
                "flex min-h-11 items-center gap-3 rounded-md bg-blue-50 px-3 py-2 text-base font-medium text-blue-700",
            }}
            inactiveProps={{
              className:
                "flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-base text-slate-600 hover:bg-slate-200 hover:text-slate-900",
            }}
          >
            <Icon className="size-4 shrink-0" />
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}
