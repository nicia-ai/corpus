import { Check, Copy } from "lucide-react";

import { cn } from "@/lib/cn";
import { TOAST_MS, useFlash } from "@/lib/forms";

// Copy-to-clipboard icon button with a brief copied-state flash. Shared
// by the MCP setup recipes, the project dashboard, and the document header
// so the affordance (and its timing) can't drift between them. A function
// `value` is read at click time, for content that lives outside React state.
export function CopyButton({
  value,
  label,
  className,
}: Readonly<{
  value: string | (() => string);
  label: string;
  className?: string;
}>): React.ReactElement {
  const [copied, flash] = useFlash(TOAST_MS);
  return (
    <button
      type="button"
      aria-label={label}
      title={copied ? "Copied" : label}
      onClick={() => {
        const text = typeof value === "string" ? value : value();
        void navigator.clipboard.writeText(text).then(flash);
      }}
      className={cn(
        "grid size-11 shrink-0 place-items-center rounded-md border border-slate-200 bg-white text-slate-400 hover:text-slate-900",
        className,
      )}
    >
      {copied ? (
        <Check className="size-4 text-green-700" />
      ) : (
        <Copy className="size-4" />
      )}
    </button>
  );
}
