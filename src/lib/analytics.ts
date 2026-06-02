import type { PostHog } from "posthog-js";

// Client-side product analytics on PostHog. Every helper here is a no-op
// until `initAnalytics` has actually loaded and started PostHog — which only
// happens in the browser when a POSTHOG_KEY is configured. Self-hosters who
// leave the key unset get no analytics and never download posthog-js;
// callers can still fire events unconditionally and get silence rather than
// errors.

export type AnalyticsConfig = Readonly<{
  posthogKey: string;
  posthogHost: string;
}> | null;

// The live client once the (browser-only) bundle has loaded, and the
// in-flight load that produced it. Both `undefined` until `initAnalytics`
// runs. `client` doubles as the ready check for every helper below;
// `loading` keeps a double-invoked init effect (React StrictMode) from
// starting two imports.
let client: PostHog | undefined;
let loading: Promise<void> | undefined;

export function initAnalytics(config: AnalyticsConfig): void {
  if (client || loading || config === null || typeof window === "undefined") {
    return;
  }
  // Import posthog-js lazily so it stays out of the bundle for self-hosters
  // who never set a key — a static import would ship it (and its sizeable
  // dependency tree) to every visitor regardless.
  loading = import("posthog-js").then(({ default: posthog }) => {
    posthog.init(config.posthogKey, {
      api_host: config.posthogHost,
      // Only people we explicitly identify get a person profile; anonymous
      // and self-host traffic stays profile-free. Keeps PII and event volume
      // scoped to signed-in users.
      person_profiles: "identified_only",
      // Single-page app: we emit $pageview on TanStack route changes
      // ourselves (see capturePageview) so the initial load and client-side
      // navigations are counted identically.
      capture_pageview: false,
    });
    client = posthog;
    // The component's first $pageview effect already ran (and no-op'd) while
    // the bundle was loading; count this landing view now that we're live.
    posthog.capture("$pageview");
  });
}

export function capturePageview(): void {
  client?.capture("$pageview");
}

export function identifyUser(
  user: Readonly<{ id: string; email?: string; name?: string }>,
): void {
  client?.identify(user.id, { email: user.email, name: user.name });
}

export function resetAnalytics(): void {
  client?.reset();
}

export function setOrganization(
  org: Readonly<{ id: string; name?: string }>,
): void {
  client?.group("organization", org.id, { name: org.name });
}

export function track(
  event: string,
  properties?: Readonly<Record<string, unknown>>,
): void {
  client?.capture(event, properties);
}
