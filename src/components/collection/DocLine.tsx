import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder as FolderIcon,
} from "lucide-react";

import { RelativeTime } from "@/components/ui/DateTime";
import { cn } from "@/lib/cn";

// The one document-row representation, used everywhere a document
// appears so every list reads identically — title + tabular metadata
// (version, size, updated relative time), with hover-revealed trailing
// actions when the parent supplies them.
export function DocLine({
  title,
  meta,
  leading,
  trailing,
  muted,
  style,
  className,
}: Readonly<{
  title: string;
  meta: React.ReactNode;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  muted?: boolean;
  style?: React.CSSProperties;
  className?: string;
}>): React.ReactElement {
  return (
    <div
      style={style}
      className={cn(
        "group flex items-center gap-3 px-3 py-2.5 text-base hover:bg-slate-50",
        muted === true && "opacity-55",
        className,
      )}
    >
      {leading}
      <FileText className="size-4 shrink-0 text-slate-400" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-slate-900">
          {title}
        </span>
        <span className="block truncate text-sm tabular-nums text-slate-500">
          {meta}
        </span>
      </span>
      {trailing}
    </div>
  );
}

// The standard meta tail for a document row: version, token estimate,
// relative last-updated. Shared so all three places it appears stay in
// lockstep.
export function docMeta(d: {
  docVersion: number;
  size: number;
  updatedAt: string;
}): React.ReactNode {
  return (
    <>
      v{d.docVersion} · ~{d.size} tok · updated{" "}
      <RelativeTime iso={d.updatedAt} />
    </>
  );
}

// Matching folder row (collapse toggle + folder glyph + name + count),
// kept visually distinct from a document by the folder icon and the
// "N documents" metadata, never by a different layout.
export function FolderLine({
  name,
  count,
  open,
  onToggle,
  trailing,
  style,
}: Readonly<{
  name: string;
  count: number;
  open?: boolean | undefined;
  onToggle?: (() => void) | undefined;
  trailing?: React.ReactNode;
  style?: React.CSSProperties;
}>): React.ReactElement {
  return (
    <div
      style={style}
      className="group flex items-center gap-3 px-3 py-2.5 text-base hover:bg-slate-50"
    >
      {onToggle !== undefined ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={open === true ? "Collapse" : "Expand"}
          className="shrink-0 text-slate-400"
        >
          {open === true ? (
            <ChevronDown className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          )}
        </button>
      ) : (
        <span className="w-4 shrink-0" aria-hidden />
      )}
      <FolderIcon className="size-4 shrink-0 text-slate-400" aria-hidden />
      <span className="min-w-0 flex-1">
        {onToggle !== undefined ? (
          <button
            type="button"
            onClick={onToggle}
            className="block truncate text-left font-medium text-slate-900"
          >
            {name}
          </button>
        ) : (
          <span className="block truncate font-medium text-slate-900">
            {name}
          </span>
        )}
        <span className="block text-sm tabular-nums text-slate-500">
          {count} document{count === 1 ? "" : "s"}
        </span>
      </span>
      {trailing}
    </div>
  );
}
