import { useSyncExternalStore } from "react";

import {
  formatTimestamp,
  formatTimestampUTC,
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
