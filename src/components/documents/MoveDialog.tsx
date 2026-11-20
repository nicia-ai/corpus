import { Folder as FolderIcon, Library } from "lucide-react";
import { useMemo, useRef } from "react";

import { Button } from "@/components/ui/Button";
import { useDialogFocusTrap } from "@/components/ui/dialog-focus";
import type { CorpusSlug, FolderSlug } from "@/ids";
import { cn } from "@/lib/cn";
import type { CorpusListItem } from "@/lib/server/corpora";
import type { FolderRow } from "@/lib/server/folders";
import { treeIndent } from "@/lib/tree";
import type { CorpusLocation } from "@/store/domain/corpus-drive";

// A folder move's disabled subtree (the folder being moved + every
// descendant) cannot be the destination — a folder can't move into itself.
// Moving across corpora is the same pick as moving within one: a corpus row
// is its top level, and its folders nest beneath it. Publishing a page is
// picking a served corpus; unpublishing is picking Drafts.
export function MoveDialog({
  corpora,
  folders,
  disabledSubtree,
  title,
  onPick,
  onClose,
}: Readonly<{
  corpora: readonly Pick<CorpusListItem, "slug" | "name" | "served">[];
  folders: readonly FolderRow[];
  disabledSubtree?: FolderSlug | undefined;
  title: string;
  onPick: (destination: CorpusLocation) => void;
  onClose: () => void;
}>): React.ReactElement {
  const firstRef = useRef<HTMLButtonElement>(null);
  // The component is conditionally rendered (mounted = open), not toggled by
  // an `open` prop, so this is a constant "always open while mounted" — the
  // hook's restore-focus/Tab-trap cleanup runs on unmount either way.
  const dialogRef = useDialogFocusTrap({
    open: true,
    onClose,
    initialFocus: firstRef,
  });

  const childFolders = useMemo(() => {
    const out = new Map<FolderSlug | null, FolderRow[]>();
    for (const folder of [...folders].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const list = out.get(folder.parentSlug) ?? [];
      list.push(folder);
      out.set(folder.parentSlug, list);
    }
    return out;
  }, [folders]);

  const blocked = new Set<FolderSlug>();
  if (disabledSubtree !== undefined) {
    const mark = (s: FolderSlug): void => {
      blocked.add(s);
      for (const c of childFolders.get(s) ?? []) mark(c.slug);
    };
    mark(disabledSubtree);
  }

  const tree = (
    corpusSlug: CorpusSlug,
    parent: FolderSlug | null,
    depth: number,
  ): React.ReactNode =>
    (childFolders.get(parent) ?? [])
      .filter((f) => f.corpusSlug === corpusSlug)
      .map((f) => {
        const isBlocked = blocked.has(f.slug);
        return (
          <div key={f.slug}>
            <button
              type="button"
              disabled={isBlocked}
              onClick={() => onPick({ corpusSlug, folderSlug: f.slug })}
              style={treeIndent(depth)}
              className={cn(
                "flex w-full items-center gap-2 py-2 pr-3 text-left text-base",
                isBlocked
                  ? "text-slate-300"
                  : "text-slate-900 hover:bg-slate-50",
              )}
            >
              <FolderIcon
                className="size-4 shrink-0 text-slate-400"
                aria-hidden
              />
              <span className="truncate">{f.name}</span>
            </button>
            {tree(corpusSlug, f.slug, depth + 1)}
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
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative flex max-h-[70vh] w-full max-w-md flex-col rounded-lg border border-slate-200 bg-white shadow-sm"
      >
        <h2 className="border-b border-slate-200 px-4 py-3 text-base font-semibold text-slate-900">
          {title}
        </h2>
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {corpora.map((corpus, i) => (
            <div key={corpus.slug}>
              <button
                ref={i === 0 ? firstRef : undefined}
                type="button"
                onClick={() =>
                  onPick({ corpusSlug: corpus.slug, folderSlug: null })
                }
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-base font-medium text-slate-900 hover:bg-slate-50"
              >
                <Library
                  className="size-4 shrink-0 text-slate-400"
                  aria-hidden
                />
                <span className="truncate">{corpus.name}</span>
                {!corpus.served && (
                  <span className="shrink-0 text-sm font-normal text-slate-500">
                    not shared with agents
                  </span>
                )}
              </button>
              {tree(corpus.slug, null, 1)}
            </div>
          ))}
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
