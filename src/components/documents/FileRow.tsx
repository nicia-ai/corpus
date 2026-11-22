import { File as FileIcon, Image as ImageIcon } from "lucide-react";
import { memo } from "react";

import type { FileSlug } from "@/ids";
import type { FileRow as FileRowData } from "@/lib/server/files";
import { treeIndent } from "@/lib/tree";
import { isImageContentType } from "@/store/domain/file-kinds";

import { InlineConfirm } from "./RowActions";

// A stored file in the corpus tree: icon, name (opens the file in a new tab),
// size, and a confirmed delete. It drags like a document, to move between
// folders and corpora. No checkbox: files are not part of the page selection.
type FileRowProps = Readonly<{
  file: FileRowData;
  depth: number;
  onDelete: (slug: FileSlug) => void;
  onDragStart: (slug: FileSlug) => void;
}>;

const KIB = 1024;

function formatSize(bytes: number): string {
  if (bytes < KIB) return `${String(bytes)} B`;
  if (bytes < KIB * KIB) return `${(bytes / KIB).toFixed(1)} KB`;
  return `${(bytes / (KIB * KIB)).toFixed(1)} MB`;
}

function FileRowComponent({
  file,
  depth,
  onDelete,
  onDragStart,
}: FileRowProps): React.ReactElement {
  const image = isImageContentType(file.contentType);
  const Icon = image ? ImageIcon : FileIcon;
  return (
    <div
      draggable
      onDragStart={() => onDragStart(file.slug)}
      style={treeIndent(depth)}
      className="group flex items-center gap-2 py-1 pr-3 text-base hover:bg-slate-50 [contain-intrinsic-size:auto_3.5rem] [content-visibility:auto]"
    >
      <span className="size-11 shrink-0" aria-hidden />
      <span title={image ? "Image" : "File"} className="flex shrink-0">
        <Icon className="size-4 text-slate-400" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <a
          href={file.url}
          target="_blank"
          rel="noopener"
          className="inline-flex min-w-0 items-center truncate font-medium text-blue-600 hover:underline"
        >
          {file.name}
        </a>
        <div className="text-sm tabular-nums text-slate-400">
          {image ? "Image" : "File"} · {formatSize(file.size)}
        </div>
      </div>
      <InlineConfirm
        prompt="Delete?"
        label="Delete file"
        onConfirm={() => onDelete(file.slug)}
      />
    </div>
  );
}

export const FileRow = memo(FileRowComponent);
