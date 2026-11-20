// The page-title block (DESIGN.md: xl 1.25 page title). One component owns
// that type token and the title/meta/actions row so ~12 routes stop
// re-deriving it. `meta` sits inline beside the title (a version chip),
// `actions` right-aligned, `subtitle` on the line below.
export function PageHeader({
  title,
  meta,
  actions,
  subtitle,
}: Readonly<{
  title: string;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  subtitle?: React.ReactNode;
}>): React.ReactElement {
  return (
    <header className="mb-6">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold">{title}</h1>
          {meta}
        </div>
        {actions && (
          <div className="flex flex-wrap items-center gap-3">{actions}</div>
        )}
      </div>
      {subtitle !== undefined && (
        <p className="mt-1 text-base text-slate-500">{subtitle}</p>
      )}
    </header>
  );
}
