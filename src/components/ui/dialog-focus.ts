import { useEffect, useRef } from "react";

// Candidate-tabbable selector — `:not()` filters cover the hidden-element
// classes querySelectorAll otherwise returns (aria-hidden subtrees, disabled
// controls, descendants of a disabled fieldset, and negative-tabindex nodes).
// The `display:none` / `visibility:hidden` case is caught by `offsetParent`.
const FOCUSABLE_SELECTOR =
  'a[href]:not([aria-hidden="true"]), button:not([disabled]):not([aria-hidden="true"]), input:not([disabled]):not([aria-hidden="true"]), select:not([disabled]):not([aria-hidden="true"]), textarea:not([disabled]):not([aria-hidden="true"]), [tabindex]:not([tabindex="-1"]):not([aria-hidden="true"])';

export function focusableIn(root: HTMLElement): readonly HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (el) => el.offsetParent !== null && !el.closest("fieldset[disabled]"),
  );
}

// The accessible modal-dialog behavior every `role="dialog"` surface in this
// app needs: restore focus to the trigger on close (skipped if the trigger
// left the DOM — a destructive action commonly unmounts its own row/button),
// focus a caller-chosen element on open, Tab-trap within the dialog, and
// Escape to close. Previously hand-duplicated per dialog (ConfirmDialog,
// ReviewPanel's mobile sheet) with no shared owner, so a fix to one silently
// missed the others. Returns the ref to attach to the dialog's root element.
export function useDialogFocusTrap({
  open,
  onClose,
  initialFocus,
}: Readonly<{
  open: boolean;
  onClose: () => void;
  initialFocus: React.RefObject<HTMLElement | null>;
}>): React.RefObject<HTMLDivElement | null> {
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  // The latest callback lives in a ref (not the effect's dep array) so an
  // inline `onClose` at the call site doesn't re-run the setup/teardown —
  // and re-capture the wrong restore target — on every render while open.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return undefined;
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    initialFocus.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || dialogRef.current === null) return;
      const focusable = focusableIn(dialogRef.current);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const target = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (target !== null && document.body.contains(target)) target.focus();
    };
  }, [open, initialFocus]);

  return dialogRef;
}
