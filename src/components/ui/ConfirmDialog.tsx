import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { focusableIn } from "@/components/ui/dialog-focus";

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
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    hostOpen = (p) => setPending(p);
    return () => {
      hostOpen = undefined;
    };
  }, []);

  useEffect(() => {
    if (pending === undefined) return;
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        pending.resolve(false);
        setPending(undefined);
        return;
      }
      if (e.key !== "Tab") return;
      if (dialogRef.current === null) return;
      const focusable = focusableIn(dialogRef.current);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Only restore when the trigger still lives in the DOM — destructive
      // flows commonly unmount the trigger row (revoke/archive/delete) by
      // the time the dialog closes; .focus() on a detached node silently
      // moves focus to body and keyboard users lose their place.
      const target = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (target !== null && document.body.contains(target)) target.focus();
    };
  }, [pending]);

  if (pending === undefined) return null;

  const { init, resolve } = pending;
  const tone = init.tone ?? "default";
  const finish = (value: boolean): void => {
    resolve(value);
    setPending(undefined);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
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
          <Button variant="secondary" onClick={() => finish(false)}>
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
