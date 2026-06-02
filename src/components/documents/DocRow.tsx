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
        "group flex items-center gap-2 py-2 pr-3 text-base",
        selected ? "bg-blue-50" : "hover:bg-slate-50",
      )}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={(e) =>
          onSelect(
            e.nativeEvent instanceof MouseEvent && e.nativeEvent.shiftKey,
          )
        }
        aria-label={`Select ${doc.title}`}
        className="size-4 shrink-0 accent-blue-600"
      />
      <FileText className="size-4 shrink-0 text-slate-400" aria-hidden />
      <Link
        to="/p/$projectId/documents/$slug"
        params={{ projectId, slug: doc.slug }}
        className="min-w-0 flex-1 truncate font-medium text-blue-600 hover:underline"
      >
        {doc.title}
      </Link>
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
            className={fieldInputClass("w-44 py-1 font-mono text-sm")}
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
          className="hidden max-w-[12rem] truncate font-mono text-sm text-slate-500 hover:text-slate-900 sm:inline"
        >
          {doc.filename}
        </button>
      )}
      {doc.collectionCount > 0 && (
        <CollectionCountBadge count={doc.collectionCount} />
      )}
      <span className="shrink-0 text-sm text-slate-400 tabular-nums">
        v{doc.docVersion} · ~{doc.size} tok
      </span>
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
