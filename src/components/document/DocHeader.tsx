import { Link } from "@tanstack/react-router";
import { Pencil } from "lucide-react";

import { PageHeader } from "@/components/ui/PageHeader";
import { tabBarClass, tabItemClass } from "@/components/ui/Tabs";
import type { DocumentSlug, ProjectId } from "@/ids";
import { cn } from "@/lib/cn";

// Title + version chip + the Current/Versions tab bar, shared by the two
// `/documents/$slug` child routes. The tabs are real `<Link>`s: the active
// tab is a route, so its data is a route loader (history is fetched only
// when Versions is the active route, and `defaultPreload: "intent"` warms
// it on hover) instead of hand-rolled client state.
export function DocHeader({
  slug,
  projectId,
  title,
  version,
  active,
  actions,
  subline,
  tabAccessory,
  onEditTitle,
}: Readonly<{
  slug: DocumentSlug;
  projectId: ProjectId;
  title: string;
  version: number;
  active: "current" | "versions";
  actions?: React.ReactNode;
  // Document identity that belongs with the title (filename + rename),
  // not buried under the tab bar — sits between the title and the tabs.
  subline?: React.ReactNode;
  // Lightweight state that belongs next to the routed tabs. Keep this inline:
  // multi-line status belongs in the document body or review rail instead.
  tabAccessory?: React.ReactNode;
  // When set, a subtle pencil sits next to the title (renaming the title
  // is a light, in-place edit — not a top-right command button).
  onEditTitle?: () => void;
}>): React.ReactElement {
  return (
    <>
      <PageHeader
        title={title}
        meta={
          <span className="flex items-center gap-2">
            <span className="text-base text-slate-500 tabular-nums">
              v{version}
            </span>
            {onEditTitle !== undefined && (
              <button
                type="button"
                aria-label="Rename title"
                title="Rename title"
                onClick={onEditTitle}
                className="grid size-7 place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900"
              >
                <Pencil className="size-4" />
              </button>
            )}
          </span>
        }
        actions={actions}
      />
      {subline !== undefined && <div className="-mt-4 mb-4">{subline}</div>}
      <div className={cn(tabBarClass, "mb-5 flex-wrap items-end gap-y-2")}>
        <div role="tablist" aria-label="Document view" className="flex gap-5">
          <Link
            to="/p/$projectId/documents/$slug"
            params={{ projectId, slug }}
            role="tab"
            aria-selected={active === "current"}
            className={tabItemClass(active === "current")}
          >
            Current
          </Link>
          <Link
            to="/p/$projectId/documents/$slug/versions"
            params={{ projectId, slug }}
            role="tab"
            aria-selected={active === "versions"}
            className={tabItemClass(active === "versions")}
          >
            Versions
          </Link>
        </div>
        {tabAccessory !== undefined && (
          <div className="min-w-0 pb-2">{tabAccessory}</div>
        )}
      </div>
    </>
  );
}
