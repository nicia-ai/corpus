import { cn } from "@/lib/cn";

// The two button shapes the product uses (DESIGN.md: one blue accent for
// primary actions, slate-bordered ghost for everything else). Exported as a
// style fn so the handful of router <Link>s styled as buttons share the
// exact same surface without a polymorphic component fighting Link's
// generics — one source of truth either way.
type Variant = "primary" | "secondary" | "danger";

const BASE =
  "rounded-md px-3 py-2 text-base font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50";

const VARIANT: Readonly<Record<Variant, string>> = {
  primary: "bg-blue-600 text-white hover:bg-blue-700",
  secondary: "border border-slate-300 hover:bg-slate-50",
  // Destructive secondary — the one red action surface (DESIGN.md: red
  // is semantic, inline-only). Shared by every "delete/archive" button.
  danger: "border border-red-300 text-red-700 hover:bg-red-50",
};

export function buttonStyles(
  variant: Variant = "primary",
  className?: string,
): string {
  return cn(BASE, VARIANT[variant], className);
}

type Props = Readonly<
  React.ComponentProps<"button"> & {
    variant?: Variant;
  }
>;

export function Button({
  variant = "primary",
  className,
  type = "button",
  ...rest
}: Props): React.ReactElement {
  return (
    <button
      type={type}
      className={buttonStyles(variant, className)}
      {...rest}
    />
  );
}
