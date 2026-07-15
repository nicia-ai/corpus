import { Trash2 } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/cn";

// Hover-only icon trigger used in the documents tree. The danger
// variant tints the hover state red without altering the layout, so a
// destructive action and a constructive one occupy the same row slot.
export function IconButton({
  label,
  onClick,
  danger,
  children,
}: Readonly<{
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}>): React.ReactElement {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "grid size-11 place-items-center rounded-md text-slate-400 hover:bg-slate-100",
        danger === true ? "hover:text-red-600" : "hover:text-slate-700",
      )}
    >
      {children}
    </button>
  );
}

// Hover trash icon that flips to an inline "prompt? Delete / Cancel"
// row — the row-scoped destructive confirm (distinct from the heavier
// `confirmDialog` used on the whole-document detail page).
export function InlineConfirm({
  prompt,
  label,
  onConfirm,
}: Readonly<{
  prompt: string;
  label: string;
  onConfirm: () => void;
}>): React.ReactElement {
  const [confirming, setConfirming] = useState(false);
  return confirming ? (
    <span className="flex shrink-0 items-center gap-2 text-sm">
      <span className="text-slate-500">{prompt}</span>
      <button
        type="button"
        onClick={() => {
          setConfirming(false);
          onConfirm();
        }}
        className="min-h-11 font-medium text-red-600 hover:underline"
      >
        Delete
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="min-h-11 text-slate-500 hover:underline"
      >
        Cancel
      </button>
    </span>
  ) : (
    <span className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      <IconButton label={label} onClick={() => setConfirming(true)} danger>
        <Trash2 className="size-4" />
      </IconButton>
    </span>
  );
}
