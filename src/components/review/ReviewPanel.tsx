import { X } from "lucide-react";
import { useRef } from "react";

import { useDialogFocusTrap } from "@/components/ui/dialog-focus";

// The mobile review surface: a focus-trapped bottom sheet holding the rail. On
// desktop the rail sits in its own column beside the editor; below `lg` it lives
// here, opened on demand. Carries the accessible dialog behavior (focus trap,
// restore, Escape) that the editor review surface reuses.
export function ReviewMobileDialog({
  open,
  onOpenChange,
  children,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}>): React.ReactElement | null {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useDialogFocusTrap({
    open,
    onClose: () => onOpenChange(false),
    initialFocus: closeRef,
  });

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 lg:hidden">
      <button
        type="button"
        aria-label="Close review"
        className="absolute inset-0 bg-slate-900/40"
        onClick={() => onOpenChange(false)}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Document review"
        className="absolute inset-x-0 bottom-0 max-h-[82vh] overflow-auto rounded-t-lg border border-slate-200 bg-white p-4 shadow-xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-medium text-slate-500">Review</div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close review"
            onClick={() => onOpenChange(false)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
