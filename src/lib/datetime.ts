// Render an ISO timestamp in the viewer's locale, degrading to the raw
// string if it isn't a valid date (a reaped/garbled value should still
// show something, not "Invalid Date"). Locale + timezone dependent, so
// it is client-only — see `RelativeTime`/`AbsoluteTime` for the
// hydration-safe wrappers that gate it behind `useHydrated`.
export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

// Deterministic absolute UTC rendering for the SSR + first-client render
// (no `Intl`/locale, so the Workers server and the browser always agree
// regardless of ICU version or timezone). The hydration-safe wrappers
// show this until mount, then swap to the locale/relative form.
export function formatTimestampUTC(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${String(d.getUTCFullYear())}-${pad(d.getUTCMonth() + 1)}-${pad(
    d.getUTCDate(),
  )} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

// Compact "how long ago" for at-a-glance triage (the add-documents
// picker, where a precise locale timestamp would be noise). Degrades to
// the locale date for anything older than ~4 weeks or an unparseable
// value, so the column never reads "Invalid Date" or a stale "53w ago".
export function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const ms = Date.now() - t;
  if (ms < MINUTE) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`;
  if (ms < WEEK) return `${Math.floor(ms / DAY)}d ago`;
  if (ms < 4 * WEEK) return `${Math.floor(ms / WEEK)}w ago`;
  return new Date(t).toLocaleDateString();
}
