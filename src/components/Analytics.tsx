import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import {
  capturePageview,
  identifyUser,
  initAnalytics,
  resetAnalytics,
  type AnalyticsConfig,
} from "@/lib/analytics";
import { authClient } from "@/lib/auth-client";

// Wires PostHog into the app's React lifecycle: one-time init, a $pageview
// per client navigation, and identify/reset that follows the Better Auth
// session. Renders nothing. With no POSTHOG_KEY configured (the OSS
// default) `config` is null and every effect below is inert.
export function Analytics({
  config,
}: Readonly<{ config: AnalyticsConfig }>): null {
  const identified = useRef<string | null>(null);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data } = authClient.useSession();

  useEffect(() => {
    initAnalytics(config);
  }, [config]);

  // Fires once on first load (init runs first) and again on every route
  // change, so navigations are counted like full page loads.
  useEffect(() => {
    capturePageview();
  }, [pathname]);

  // Tie events to the signed-in user; clear the link on sign-out so the
  // next visitor on a shared browser starts anonymous again.
  useEffect(() => {
    const user = data?.user;
    if (user) {
      if (identified.current !== user.id) {
        identifyUser({ id: user.id, email: user.email, name: user.name });
        identified.current = user.id;
      }
    } else if (identified.current !== null) {
      resetAnalytics();
      identified.current = null;
    }
  }, [data]);

  return null;
}
