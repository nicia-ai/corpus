import { cn } from "@/lib/cn";
import { formatNumber } from "@/util";

// Each over-budget state's bar fill, number/note colour, and note text
// in one place.
const SIZE = {
  ok: { fill: "bg-blue-600", num: "text-slate-900", note: undefined },
  over: {
    fill: "bg-amber-500",
    num: "text-amber-700",
    note: "Over the always-include budget — the always-loaded set will eat more of the agent’s context than configured. Raise the budget if intentional, or move docs to on-demand.",
  },
} as const;

export type SizeState = keyof typeof SIZE;

export function sizeStateFor(total: number, budget: number): SizeState {
  return total <= budget ? "ok" : "over";
}

// Shown when at least one always-include document is present, comparing
// the assembled always-include token total against the collection's
// configured `alwaysIncludeBudgetTokens`. Authoring-side guidance only.
export function BudgetMeter({
  total,
  budget,
  sizeState,
}: Readonly<{
  total: number;
  budget: number;
  sizeState: SizeState;
}>): React.ReactElement {
  // budget === 0 with content is "over" (always-include set exists past
  // the owner's asserted zero); with no content it's an empty bar, not
  // a misleading full one. Avoids the 0/0 → NaN trap too.
  const pct =
    total === 0 ? 0 : budget === 0 ? 100 : Math.min(total / budget, 1) * 100;
  const s = SIZE[sizeState];
  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-2">
        <span className="text-sm tabular-nums text-slate-500">
          <span className={cn("font-semibold", s.num)}>
            ~{formatNumber(total)}
          </span>{" "}
          / {formatNumber(budget)} tokens
        </span>
        <div className="h-1 w-32 overflow-hidden rounded-full bg-slate-100">
          <div
            className={cn("h-full rounded-full", s.fill)}
            style={{ width: `${String(pct)}%` }}
          />
        </div>
      </div>
      {s.note !== undefined && (
        <p className={cn("mt-1 max-w-prose text-sm", s.num)}>{s.note}</p>
      )}
    </div>
  );
}
