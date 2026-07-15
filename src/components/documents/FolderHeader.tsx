import {
  ChevronDown,
  ChevronRight,
  Folder as FolderIcon,
  FolderInput,
  FolderPlus,
  Pencil,
  Trash2,
} from "lucide-react";
import { memo, useState } from "react";

import { fieldInputClass } from "@/components/Field";
import { cn } from "@/lib/cn";
import type { FolderRow } from "@/lib/server/folders";
import { treeIndent } from "@/lib/tree";

import { IconButton } from "./RowActions";

// One folder row in the documents tree: collapse toggle, name (with
// inline rename), and hover-revealed actions for add-subfolder /
// move / rename / delete. The drag handle is the whole row, so the
// rename input disables draggable while editing.
type FolderHeaderProps = Readonly<{
  folder: FolderRow;
  depth: number;
  open: boolean;
  highlighted: boolean;
  onToggle: (slug: FolderRow["slug"]) => void;
  onDragStart: (slug: FolderRow["slug"]) => void;
  onDragOver: (slug: FolderRow["slug"], e: React.DragEvent) => void;
  onDrop: (slug: FolderRow["slug"], e: React.DragEvent) => void;
  onAddChild: (slug: FolderRow["slug"]) => void;
  onMove: (slug: FolderRow["slug"]) => void;
  onRename: (slug: FolderRow["slug"], name: string) => Promise<void>;
  onDelete: (slug: FolderRow["slug"]) => Promise<void>;
}>;

function FolderHeaderComponent({
  folder,
  depth,
  open,
  highlighted,
  onToggle,
  onDragStart,
  onDragOver,
  onDrop,
  onAddChild,
  onMove,
  onRename,
  onDelete,
}: FolderHeaderProps): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(folder.name);
  const [confirming, setConfirming] = useState(false);

  return (
    <div
      draggable={!editing}
      onDragStart={() => onDragStart(folder.slug)}
      onDragOver={(e) => onDragOver(folder.slug, e)}
      onDrop={(e) => {
        e.stopPropagation();
        onDrop(folder.slug, e);
      }}
      style={treeIndent(depth)}
      className={cn(
        "group flex items-center gap-2 py-1 pr-3 text-base [contain-intrinsic-size:auto_3.5rem] [content-visibility:auto]",
        highlighted ? "bg-blue-50" : "hover:bg-slate-50",
      )}
    >
      <button
        type="button"
        onClick={() => onToggle(folder.slug)}
        aria-label={open ? "Collapse" : "Expand"}
        className="grid size-11 shrink-0 place-items-center rounded-md text-slate-400 hover:bg-slate-100"
      >
        {open ? (
          <ChevronDown className="size-4" />
        ) : (
          <ChevronRight className="size-4" />
        )}
      </button>
      <FolderIcon className="size-4 shrink-0 text-slate-400" aria-hidden />
      {editing ? (
        <form
          className="flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            const v = name.trim();
            if (v === "" || v === folder.name) {
              setEditing(false);
              return;
            }
            void onRename(folder.slug, v).then(() => setEditing(false));
          }}
        >
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => setEditing(false)}
            className={fieldInputClass("py-1!")}
          />
        </form>
      ) : (
        <span className="flex-1 truncate font-medium text-slate-900">
          {folder.name}
        </span>
      )}

      {confirming ? (
        <span className="flex items-center gap-2 text-sm">
          <span className="text-slate-500">
            Delete folder and everything in it?
          </span>
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
              void onDelete(folder.slug);
            }}
            className="font-medium text-red-600 hover:underline"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="text-slate-500 hover:underline"
          >
            Cancel
          </button>
        </span>
      ) : (
        <span className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
          <IconButton
            label="New subfolder"
            onClick={() => onAddChild(folder.slug)}
          >
            <FolderPlus className="size-4" />
          </IconButton>
          <IconButton label="Move folder" onClick={() => onMove(folder.slug)}>
            <FolderInput className="size-4" />
          </IconButton>
          <IconButton label="Rename folder" onClick={() => setEditing(true)}>
            <Pencil className="size-4" />
          </IconButton>
          <IconButton
            label="Delete folder"
            onClick={() => setConfirming(true)}
            danger
          >
            <Trash2 className="size-4" />
          </IconButton>
        </span>
      )}
    </div>
  );
}

export const FolderHeader = memo(FolderHeaderComponent);
