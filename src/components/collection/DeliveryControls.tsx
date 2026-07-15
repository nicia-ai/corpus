import { Check, Plus, X } from "lucide-react";

import { cn } from "@/lib/cn";
import type { ColMemberRow } from "@/lib/server/collections";

export type Delivery = ColMemberRow["delivery"];

// Single "Add" affordance — adding always lands the row in the default
// on-demand tier ("reference"); the owner promotes it to always-loaded
// from the members pane via DeliveryToggle. Keeps the add panel a flat
// list of one verb; tier choice happens after, where the consequence
// (the budget) lives.
export function AddAction({
  added,
  pending,
  label,
  onAdd,
}: Readonly<{
  added: boolean;
  pending: boolean;
  label: string;
  onAdd: () => void;
}>): React.ReactElement {
  if (added)
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-sm text-slate-400">
        <Check className="size-4" aria-hidden />
        Added
      </span>
    );
  return (
    <button
      type="button"
      disabled={pending}
      aria-label={label}
      onClick={onAdd}
      className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50"
    >
      <Plus className="size-4" aria-hidden />
      Add
    </button>
  );
}

// Single-boolean switch — "Always include" on means the row is pre-loaded
// into every read_collection call (delivery: "core"); off means it stays
// in the outline and the agent pulls it by path on demand (delivery:
// "reference"). `label` is the per-row accessible name (the visible
// "Always include" text repeats for every row, so callers thread the
// document/folder name in for screen readers).
export function DeliveryToggle({
  value,
  label,
  onChange,
}: Readonly<{
  value: Delivery;
  label: string;
  onChange: (delivery: Delivery) => void;
}>): React.ReactElement {
  const on = value === "core";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => {
        onChange(on ? "reference" : "core");
      }}
      className={cn(
        "inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-sm font-medium transition-colors",
        on
          ? "border-blue-200 bg-blue-50 text-blue-700"
          : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50",
      )}
    >
      {on ? (
        <Check className="size-3.5" aria-hidden />
      ) : (
        <span
          className="inline-block size-3.5 rounded-sm border border-slate-300"
          aria-hidden
        />
      )}
      Always include
    </button>
  );
}

// Hover-revealed inline destructive — used for "remove document from
// collection" and "unlink folder from collection". The fade-in is the
// only state; the actual confirm-and-revert behavior is the parent's job.
export function RemoveAction({
  label,
  onClick,
}: Readonly<{ label: string; onClick: () => void }>): React.ReactElement {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-slate-400 opacity-0 hover:bg-white hover:text-red-700 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
    >
      <X className="size-4" aria-hidden />
      Remove
    </button>
  );
}
