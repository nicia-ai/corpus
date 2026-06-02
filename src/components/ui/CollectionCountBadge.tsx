import { cn } from "@/lib/cn";

// DESIGN.md signature token — the shared-linkage emphasis. A document
// living in agent collections is the product's whole point, so the blue-50
// wash (the one place the accent is spent on data, per the color
// budget) gets a single home shared by the project graph and the
// documents list. Pluralizes; caller decides when to render it.
export function CollectionCountBadge({
  count,
  className,
}: Readonly<{ count: number; className?: string }>): React.ReactElement {
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center rounded-full bg-blue-50 px-2 text-sm font-medium text-blue-600 tabular-nums",
        className,
      )}
    >
      In {count} collection{count === 1 ? "" : "s"}
    </span>
  );
}
