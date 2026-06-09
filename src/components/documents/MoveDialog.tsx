import { Folder as FolderIcon } from "lucide-react";
import { useEffect } from "react";

import { Button } from "@/components/ui/Button";
import type { FolderSlug } from "@/ids";
import { cn } from "@/lib/cn";
import type { FolderRow } from "@/lib/server/folders";
import { treeIndent } from "@/lib/tree";

// `null` parent = project root. A folder move's disabled subtree
// (the folder being moved + every descendant) cannot be the destination
// — a folder can't move into itself.
type DropTarget = FolderSlug | null;

// Concise folder picker — the drag-free way to move a selection (or one
// folder) into a folder when the tree is too long to drag across. The
// Top-level row pins above the tree; subtree rows recurse to render the
// full hierarchy with depth-indented buttons.
export function MoveDialog({
  folders,
  childFolders,
  disabledSubtree,
  title,
  onPick,
  onClose,
}: Readonly<{
  folders: readonly FolderRow[];
  childFolders: Map<DropTarget, FolderRow[]>;
  disabledSubtree?: FolderSlug | undefined;
  title: string;
  onPick: (target: DropTarget) => void;
  onClose: () => void;
}>): React.ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const blocked = new Set<FolderSlug>();
  if (disabledSubtree !== undefined) {
    const mark = (s: FolderSlug): void => {
      blocked.add(s);
      for (const c of childFolders.get(s) ?? []) mark(c.slug);
    };
    mark(disabledSubtree);
  }

  const tree = (parent: DropTarget, depth: number): React.ReactNode =>
    (childFolders.get(parent) ?? []).map((f) => {
      const isBlocked = blocked.has(f.slug);
      return (
        <div key={f.slug}>
          <button
            type="button"
            disabled={isBlocked}
            onClick={() => onPick(f.slug)}
            style={treeIndent(depth)}
            className={cn(
              "flex w-full items-center gap-2 py-2 pr-3 text-left text-base",
              isBlocked ? "text-slate-300" : "text-slate-900 hover:bg-slate-50",
            )}
          >
            <FolderIcon
              className="size-4 shrink-0 text-slate-400"
              aria-hidden
            />
            <span className="truncate">{f.name}</span>
          </button>
          {tree(f.slug, depth + 1)}
        </div>
      );
    });

  return (
    <div className="fixed inset-0 z-70 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onClose}
        className="absolute inset-0 bg-slate-900/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative flex max-h-[70vh] w-full max-w-md flex-col rounded-lg border border-slate-200 bg-white shadow-sm"
      >
        <h2 className="border-b border-slate-200 px-4 py-3 text-base font-semibold text-slate-900">
          {title}
        </h2>
        <div className="min-h-0 flex-1 overflow-auto py-1">
          <button
            type="button"
            onClick={() => onPick(null)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-base text-slate-900 hover:bg-slate-50"
          >
            <FolderIcon
              className="size-4 shrink-0 text-slate-400"
              aria-hidden
            />
            Top level
          </button>
          {folders.length > 0 && tree(null, 0)}
        </div>
        <div className="flex justify-end border-t border-slate-200 px-4 py-3">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
