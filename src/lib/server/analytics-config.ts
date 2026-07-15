import { createServerFn } from "@tanstack/react-start";

import { resolveServerEnv } from "@/control/env.server";
import type { AnalyticsConfig } from "@/lib/analytics";
import { assertServerContext as srv } from "@/lib/server-context";

// The browser needs the (publishable) PostHog project key + host to boot
// analytics, but Workers expose no client-visible env — so it comes from a
// server fn, like getGoogleEnabled. Returns null when no key is configured
// (the OSS default), and the client then never loads PostHog.
export const getAnalyticsConfig = createServerFn({ method: "GET" }).handler(
  ({ context }): AnalyticsConfig =>
    resolveServerEnv(srv(context).env).posthog ?? null,
);
