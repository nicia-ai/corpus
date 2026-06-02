import { cn } from "@/lib/cn";

// DESIGN.md spends the blue accent on exactly two things: the primary
// action and the shared-linkage fan-out on the graph. Inline text links
// are navigation, not either of those, so they read as slate with a
// persistent underline — the affordance is the underline, not the color,
// and the graph stays the only blue moment on screen. One helper so every
// link (Link, button, a) wears the same treatment without re-deriving it.
export function textLinkClass(className?: string): string {
  return cn(
    "text-slate-500 underline underline-offset-2 hover:text-slate-900",
    className,
  );
}
