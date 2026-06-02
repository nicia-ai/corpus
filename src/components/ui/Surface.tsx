import { cn } from "@/lib/cn";

// DESIGN.md surface token: white, hairline slate-200 border, lg (8px)
// radius. `cardClass` is the style fn (so a <form> can wear it directly
// without an extra wrapper); `Card` is the element form; `EmptyState` is
// the recurring "nothing here yet" panel.
const SURFACE = "rounded-lg border border-slate-200 bg-white";

export function cardClass(className?: string): string {
  return cn(SURFACE, "p-6", className);
}

// List/table container: the same hairline surface as Card, plus clipped
// corners so inner rows/dividers don't bleed past the radius. No shadow —
// every surface in the app reads flat (white + slate-200 hairline on the
// slate-50 page), depth coming from the border + bg contrast, not
// elevation (DESIGN.md: minimal, no texture).
export function listSurface(className?: string): string {
  return cn(SURFACE, "overflow-hidden", className);
}

export function Card({
  className,
  children,
}: Readonly<{
  className?: string;
  children: React.ReactNode;
}>): React.ReactElement {
  return <div className={cardClass(className)}>{children}</div>;
}

export function EmptyState({
  children,
}: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  return (
    <p className={cn(SURFACE, "p-6 text-base text-slate-500")}>{children}</p>
  );
}
