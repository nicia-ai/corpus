import { clsx } from "clsx";

// DESIGN.md: blue is spent on primary action and the shared-linkage
// fan-out; the wordmark borrows that one pixel of accent (the period).

type Size = "sm" | "md" | "lg";

const SIZE: Readonly<Record<Size, string>> = {
  sm: "text-xl",
  md: "text-2xl",
  lg: "text-3xl",
};

export function Wordmark({
  size = "md",
  className,
}: Readonly<{
  size?: Size;
  className?: string;
}>): React.ReactElement {
  return (
    <span
      className={clsx(
        SIZE[size],
        "font-semibold tracking-tight text-slate-900",
        className,
      )}
    >
      Corpus<span className="text-blue-600">.</span>
    </span>
  );
}
