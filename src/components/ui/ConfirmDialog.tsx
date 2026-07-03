import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { useDialogFocusTrap } from "@/components/ui/dialog-focus";

// Replaces `window.confirm` so the destructive-action surface matches
// the rest of the product. One `<ConfirmHost>` is mounted at the root
// (`__root.tsx`); `confirmDialog(...)` opens it and resolves on the
// user's choice.

export type ConfirmInit = Readonly<{
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
}>;

type Pending = Readonly<{
  init: ConfirmInit;
  resolve: (value: boolean) => void;
}>;

let hostOpen: ((p: Pending) => void) | undefined;

export function confirmDialog(init: ConfirmInit): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (hostOpen === undefined) {
      resolve(false);
      return;
    }
    hostOpen({ init, resolve });
  });
}

export function ConfirmHost(): React.ReactElement | null {
  const [pending, setPending] = useState<Pending>();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    hostOpen = (p) => setPending(p);
    return () => {
      hostOpen = undefined;
    };
  }, []);

  const finish = (value: boolean): void => {
    pending?.resolve(value);
    setPending(undefined);
  };

  // For destructive actions, focus the safe option first so an accidental
  // Enter cancels rather than confirms (Apple HIG, WCAG 3.3.4 Error
  // Prevention — legal/financial/destructive).
  const isDanger = (pending?.init.tone ?? "default") === "danger";
  const dialogRef = useDialogFocusTrap({
    open: pending !== undefined,
    onClose: () => finish(false),
    initialFocus: isDanger ? cancelRef : confirmRef,
  });

  if (pending === undefined) return null;

  const { init } = pending;
  const tone = init.tone ?? "default";

  return (
    <div className="fixed inset-0 z-70 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => finish(false)}
        className="absolute inset-0 bg-slate-900/40"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        className="relative w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
      >
        <h2 id="confirm-title" className="text-xl font-semibold text-slate-900">
          {init.title}
        </h2>
        {init.body !== undefined && (
          <p className="mt-1 text-base text-slate-500">{init.body}</p>
        )}
        <div className="mt-5 flex items-center justify-end gap-3">
          <Button
            ref={cancelRef}
            variant="secondary"
            onClick={() => finish(false)}
          >
            {init.cancelLabel ?? "Cancel"}
          </Button>
          <Button
            ref={confirmRef}
            variant={tone === "danger" ? "danger" : "primary"}
            onClick={() => finish(true)}
          >
            {init.confirmLabel ?? "Confirm"}
          </Button>
        </div>
      </div>
    </div>
  );
}
