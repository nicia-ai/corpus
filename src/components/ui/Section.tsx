// `tone` carries the page's primary/secondary hierarchy: a primary
// section is a solid slate-900 title with an optional count chip; a
// secondary section is a quiet uppercase eyebrow. One component so the
// styling can't drift between Collection detail and Activity.

export function Section({
  label,
  hint,
  count,
  tone = "secondary",
  className,
  children,
}: Readonly<{
  label: string;
  hint?: string | undefined;
  count?: number | undefined;
  tone?: "primary" | "secondary";
  className?: string;
  children: React.ReactNode;
}>): React.ReactElement {
  return (
    <section className={className}>
      {tone === "primary" ? (
        <h2 className="flex items-baseline gap-2 text-lg font-semibold text-slate-900">
          {label}
          {count !== undefined && (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-sm font-medium tabular-nums text-slate-600">
              {count}
            </span>
          )}
        </h2>
      ) : (
        <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">
          {label}
          {count !== undefined && (
            <span className="ml-2 tabular-nums text-slate-400">{count}</span>
          )}
        </h2>
      )}
      {hint !== undefined && (
        <p className="mt-1 max-w-prose text-sm text-slate-500">{hint}</p>
      )}
      <div className="mt-3">{children}</div>
    </section>
  );
}
