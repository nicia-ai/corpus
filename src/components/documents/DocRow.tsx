import { Link } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import { useState } from "react";

import { fieldInputClass } from "@/components/Field";
import { CollectionCountBadge } from "@/components/ui/CollectionCountBadge";
import type { DocumentSlug, ProjectId } from "@/ids";
import { cn } from "@/lib/cn";
import type { DocListItem } from "@/lib/server/documents";
import { treeIndent } from "@/lib/tree";

import { InlineConfirm } from "./RowActions";

// One document row in the documents tree: checkbox + title link (to the
// detail page), inline filename rename, collection-count badge, and
// hover-revealed delete confirm. Shift-click on the checkbox flips
// `range` so the parent extends the selection from the last anchor.
export function DocRow({
  doc,
  projectId,
  depth,
  selected,
  onSelect,
  onArchive,
  onDragStart,
  onRename,
}: Readonly<{
  doc: DocListItem;
  projectId: ProjectId;
  depth: number;
  selected: boolean;
  onSelect: (range: boolean) => void;
  onArchive: () => void;
  onDragStart: () => void;
  onRename: (filename: string) => Promise<void>;
}>): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(doc.filename);
  return (
    <div
      draggable={!editing}
      onDragStart={onDragStart}
      style={treeIndent(depth)}
      className={cn(
        "group flex items-center gap-2 py-1 pr-3 text-base [contain-intrinsic-size:auto_3.5rem] [content-visibility:auto]",
        selected ? "bg-blue-50" : "hover:bg-slate-50",
      )}
    >
      <label className="grid size-11 shrink-0 place-items-center">
        <input
          type="checkbox"
          checked={selected}
          onChange={(e) =>
            onSelect(
              e.nativeEvent instanceof MouseEvent && e.nativeEvent.shiftKey,
            )
          }
          aria-label={`Select ${doc.title}`}
          className="size-5 accent-blue-600"
        />
      </label>
      <FileText className="size-4 shrink-0 text-slate-400" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Link
            to="/p/$projectId/documents/$slug"
            params={{ projectId, slug: doc.slug }}
            className="inline-flex min-h-11 min-w-0 items-center truncate font-medium text-blue-600 hover:underline"
          >
            {doc.title}
          </Link>
          {doc.pendingSuggestions > 0 && (
            <span
              title={`${doc.pendingSuggestions} suggestion${doc.pendingSuggestions === 1 ? "" : "s"} awaiting review`}
              className="inline-flex w-fit shrink-0 items-center rounded-sm bg-amber-50 px-1.5 text-sm font-medium text-amber-700 tabular-nums"
            >
              {doc.pendingSuggestions} pending
            </span>
          )}
          {doc.collectionCount > 0 && (
            <CollectionCountBadge count={doc.collectionCount} />
          )}
        </div>
        <div className="flex items-center gap-2 text-sm tabular-nums text-slate-400">
          <span className="shrink-0">
            v{doc.docVersion} · ~{doc.size} tokens
          </span>
          {editing ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const v = name.trim();
                if (v === "" || v === doc.filename) {
                  setEditing(false);
                  return;
                }
                void onRename(v).then(() => setEditing(false));
              }}
            >
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => setEditing(false)}
                className={fieldInputClass("w-44! py-1! font-mono text-sm!")}
              />
            </form>
          ) : (
            <button
              type="button"
              onClick={() => {
                setName(doc.filename);
                setEditing(true);
              }}
              title="Rename file"
              className="hidden min-h-11 max-w-48 truncate font-mono text-slate-400 hover:text-slate-900 sm:inline"
            >
              {doc.filename}
            </button>
          )}
        </div>
      </div>
      <InlineConfirm
        prompt="Delete?"
        label="Delete document"
        onConfirm={onArchive}
      />
    </div>
  );
}

// Type alias re-exported for parents that build a slug-based selection
// without importing the brand directly.
export type { DocumentSlug };
