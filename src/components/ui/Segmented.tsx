// One styled segmented control behind a headless value/onChange contract —
// used for the home Graph/List switch and the editor Write/Preview and
// history Changes/Rendered toggles. Callers own the option vocabulary and
// state; the chrome lives here once.
type Option<T extends string> = Readonly<{ value: T; label: string }>;

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
      className="inline-flex rounded-md border border-slate-300 p-0.5 text-base"
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={
              active
                ? "rounded bg-slate-100 px-3 py-1 font-medium text-slate-900"
                : "rounded px-3 py-1 text-slate-500 hover:text-slate-900"
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
