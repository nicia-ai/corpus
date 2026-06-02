import { Check, Copy } from "lucide-react";

import { cn } from "@/lib/cn";
import { TOAST_MS, useFlash } from "@/lib/forms";

// Copy-to-clipboard icon button with a brief copied-state flash. Shared
// by the MCP setup recipes and the project dashboard so the affordance
// (and its timing) can't drift between them.
export function CopyButton({
  value,
  label,
  className,
}: Readonly<{
  value: string;
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
        void navigator.clipboard.writeText(value).then(flash);
      }}
      className={cn(
        "shrink-0 rounded-md border border-slate-200 bg-white p-1.5 text-slate-400 hover:text-slate-900",
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
