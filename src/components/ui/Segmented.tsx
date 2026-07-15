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

function nextOptionIndex(
  key: string,
  current: number,
  last: number,
): number | undefined {
  switch (key) {
    case "ArrowRight":
      return current === last ? 0 : current + 1;
    case "ArrowLeft":
      return current === 0 ? last : current - 1;
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return undefined;
  }
}

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
  const handleKey = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    const index = options.findIndex((option) => option.value === value);
    if (index < 0) return;
    const last = options.length - 1;
    const next = nextOptionIndex(event.key, index, last);
    if (next === undefined) return;
    const option = options[next];
    if (option === undefined) return;
    event.preventDefault();
    if (next !== index) onChange(option.value);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>('button[role="tab"]')
      [next]?.focus();
  };

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
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={handleKey}
            className={cn(
              "inline-flex min-h-11 items-center gap-1.5 rounded px-3 py-1.5",
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
