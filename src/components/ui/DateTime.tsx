import { useSyncExternalStore } from "react";

import {
  formatTimestamp,
  formatTimestampUTC,
  recentTime,
  relativeTime,
} from "@/lib/datetime";

const unsubscribe = (): void => undefined;
const noopSubscribe = (): (() => void) => unsubscribe;

// False during SSR and the first client render (both read the server
// snapshot, so the markup matches), then true after hydration. Gates
// locale/relative date output — the Workers server runs in UTC with a
// different `Date.now()` than the browser, so rendering those directly
// desyncs hydration (see react.dev/link/hydration-mismatch).
function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

// Compact "Nd ago" once hydrated, with the full local timestamp on hover;
// a deterministic UTC absolute before then so SSR and the first client
// render agree.
export function RelativeTime({
  iso,
  className,
}: Readonly<{ iso: string; className?: string }>): React.ReactElement {
  const hydrated = useHydrated();
  return (
    <span
      className={className}
      title={hydrated ? formatTimestamp(iso) : undefined}
    >
      {hydrated ? relativeTime(iso) : formatTimestampUTC(iso)}
    </span>
  );
}

// One shared one-second clock for every mounted LiveRelativeTime. The interval
// runs only while something subscribes; 0 is the server snapshot.
const CLOCK_TICK_MS = 1000;
const clockListeners = new Set<() => void>();
const clock = { now: 0, timer: undefined as number | undefined };

function subscribeClock(listener: () => void): () => void {
  clockListeners.add(listener);
  if (clock.timer === undefined) {
    clock.now = Date.now();
    clock.timer = window.setInterval(() => {
      clock.now = Date.now();
      for (const notify of clockListeners) notify();
    }, CLOCK_TICK_MS);
  }
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size > 0 || clock.timer === undefined) return;
    window.clearInterval(clock.timer);
    clock.timer = undefined;
  };
}

function readClock(): number {
  if (clock.now === 0) clock.now = Date.now();
  return clock.now;
}

function useClock(): number {
  return useSyncExternalStore(subscribeClock, readClock, () => 0);
}

// Like RelativeTime, but re-renders every second with seconds precision
// ("20s ago"), for activity that may still be happening.
export function LiveRelativeTime({
  iso,
  className,
}: Readonly<{ iso: string; className?: string }>): React.ReactElement {
  const now = useClock();
  const hydrated = now !== 0;
  return (
    <span
      className={className}
      title={hydrated ? formatTimestamp(iso) : undefined}
    >
      {hydrated ? recentTime(iso, now) : formatTimestampUTC(iso)}
    </span>
  );
}

// Absolute timestamp in the viewer's locale once hydrated; the
// deterministic UTC form before then.
export function AbsoluteTime({
  iso,
  className,
}: Readonly<{ iso: string; className?: string }>): React.ReactElement {
  const hydrated = useHydrated();
  return (
    <span className={className}>
      {hydrated ? formatTimestamp(iso) : formatTimestampUTC(iso)}
    </span>
  );
}
