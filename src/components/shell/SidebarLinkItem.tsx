import { ExternalLink, type LucideIcon } from "lucide-react";

import type { SidebarLink } from "@/control/env";

// A configured sidebar-footer link (Docs, Help). An `external` link opens in
// a new tab with an external-link glyph (an off-site URL, or the docs site
// that lives outside the app SPA); otherwise (a mailto:) it follows in place.
// Rendered only when the link is configured, so `link` is always present.
export function SidebarLinkItem({
  link,
  icon: Icon,
}: Readonly<{ link: SidebarLink; icon: LucideIcon }>): React.ReactElement {
  return (
    <a
      href={link.href}
      {...(link.external
        ? { target: "_blank", rel: "noopener noreferrer" }
        : {})}
      className="mb-1 flex items-center gap-2.5 rounded-md px-2 py-2 text-base font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900"
    >
      <Icon className="size-4 shrink-0" />
      <span className="flex-1">{link.label}</span>
      {link.external && (
        <ExternalLink
          className="size-3.5 shrink-0 text-slate-400"
          aria-hidden
        />
      )}
    </a>
  );
}
