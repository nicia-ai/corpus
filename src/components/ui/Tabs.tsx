import { cn } from "@/lib/cn";

// Single source of truth for the underline-tab chrome, shared by two
// interaction models with the same look: the stateful `Tabs` below
// (button + value/onChange — e.g. the MCP client picker, pure client
// state) and the routed document tab bar (which renders TanStack `<Link>`s
// so each tab is a real route with its own loader + intent preloading).
export const tabBarClass = "flex gap-5 border-b border-slate-200";

export function tabItemClass(active: boolean): string {
  return active
    ? "-mb-px border-b-2 border-slate-900 pb-2 text-base font-medium text-slate-900"
    : "-mb-px border-b-2 border-transparent pb-2 text-base text-slate-500 hover:text-slate-900";
}

type Option<T extends string> = Readonly<{ value: T; label: string }>;

export function Tabs<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
}: Readonly<{
  options: readonly Option<T>[];
  value: T;
  onChange: (next: T) => void;
  ariaLabel: string;
  className?: string;
}>): React.ReactElement {
  // WAI-ARIA tab pattern: arrow keys move focus between tabs (and
  // activate the focused one — "automatic activation," which fits a
  // pure-presentation switch like ours where moving "selects"). Home /
  // End jump to the ends. Tab itself moves out of the tablist (handled
  // for free by `tabIndex` = 0 on the active tab, -1 on the others).
  // Focus follows selection: when value updates, tabIndex flips to -1
  // on the prior button, so we must imperatively move DOM focus to the
  // newly-active button or focus is stranded on a non-tabbable element.
  const handleKey = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    const idx = options.findIndex((o) => o.value === value);
    if (idx < 0) return;
    const last = options.length - 1;
    const next =
      e.key === "ArrowRight"
        ? idx === last
          ? 0
          : idx + 1
        : e.key === "ArrowLeft"
          ? idx === 0
            ? last
            : idx - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : -1;
    if (next < 0 || next === idx) return;
    e.preventDefault();
    const nextOption = options[next];
    if (nextOption === undefined) return;
    onChange(nextOption.value);
    // Move focus to the button that just became active; the parent
    // tablist owns the buttons, so query by aria-selected (will reflect
    // the new value after the next render — schedule via rAF so the
    // ref points at the freshly-tabbable button).
    const tablist = e.currentTarget.parentElement;
    if (tablist === null) return;
    const buttons =
      tablist.querySelectorAll<HTMLButtonElement>('button[role="tab"]');
    const target = buttons[next];
    if (target !== undefined) target.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(tabBarClass, className)}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={handleKey}
            className={tabItemClass(active)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
