import { useEffect, useState } from "react";

// `showToast` is a module-level publisher so any handler can fire one
// without threading context. The host is client-only — listeners are
// registered in `useEffect`, so on the server the publisher is a no-op.

type Toast = Readonly<{ id: number; message: string }>;

const DURATION_MS = 5000;

let nextId = 0;
const listeners = new Set<(t: Toast) => void>();

export function showToast(message: string): void {
  nextId += 1;
  const t: Toast = { id: nextId, message };
  for (const fn of listeners) fn(t);
}

export function ToastHost(): React.ReactElement | null {
  const [items, setItems] = useState<readonly Toast[]>([]);

  useEffect(() => {
    const timers = new Set<number>();
    const fn = (t: Toast): void => {
      setItems((prev) => [...prev, t]);
      const handle = window.setTimeout(() => {
        timers.delete(handle);
        setItems((prev) => prev.filter((x) => x.id !== t.id));
      }, DURATION_MS);
      timers.add(handle);
    };
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
      for (const h of timers) window.clearTimeout(h);
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-4 z-[60] flex flex-col items-center gap-2 px-4"
    >
      {items.map((t) => (
        <div
          key={t.id}
          role="status"
          className="pointer-events-auto max-w-md rounded-md bg-slate-700 px-4 py-2 text-base text-white shadow-sm"
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
