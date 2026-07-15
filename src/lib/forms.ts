import { useCallback, useEffect, useRef, useState } from "react";

// Transient confirmation toast ("Saved", "Copied") auto-dismiss window.
export const TOAST_MS = 1500;

// One submit primitive for every mutating handler: surfaces failures
// (server fns reject or return a non-ok outcome the caller throws on),
// exposes a `pending` flag for disabling controls, and a ref lock so a
// double-click in the same tick can't fire the action twice.
export function useSubmit<A extends unknown[]>(
  action: (...args: A) => Promise<void>,
) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const lock = useRef(false);
  const actionRef = useRef(action);

  // Event handlers should stay referentially stable so memoized rows do not
  // all re-render when unrelated form state changes. Refresh the action after
  // each commit; browser events run after passive effects have flushed.
  useEffect(() => {
    actionRef.current = action;
  }, [action]);

  const run = useCallback(async (...args: A): Promise<void> => {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError(undefined);
    try {
      await actionRef.current(...args);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      lock.current = false;
      setPending(false);
    }
  }, []);

  return { pending, error, run };
}

// A boolean that flips true on `flash()` and auto-resets after `ms`.
// Owned by a component that outlives the flashed element so the signal
// survives a keyed remount of its children.
export function useFlash(ms: number) {
  const [on, setOn] = useState(false);
  function flash() {
    setOn(true);
    setTimeout(() => setOn(false), ms);
  }
  return [on, flash] as const;
}
