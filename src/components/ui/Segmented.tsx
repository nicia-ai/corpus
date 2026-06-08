import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/cn";

// One styled segmented control behind a headless value/onChange contract —
// used for the home Graph/List switch and the editor Write/Preview and history
// compare toggles. Callers own the option vocabulary and state; the chrome
// lives here once.
type Option<T extends string> = Readonly<{
  value: T;
  label: string;
  icon?: LucideIcon;
}>;

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: Readonly<{
  options: readonly Option<T>[];
  value: T;
  onChange: (next: T) => void;
  ariaLabel: string;
}>): React.ReactElement {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="inline-flex rounded-md border border-slate-300 bg-white p-0.5 text-sm"
    >
      {options.map((o) => {
        const active = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded px-3 py-1.5",
              active
                ? "bg-slate-100 font-medium text-slate-900"
                : "text-slate-500 hover:text-slate-900",
            )}
          >
            {Icon && <Icon className="size-3.5" aria-hidden="true" />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
