import { createServerFn } from "@tanstack/react-start";

import { resolveServerEnv } from "@/control/env.server";
import { assertServerContext as srv } from "@/lib/server-context";

// Whether the sign-in / sign-up pages should render "Continue with
// Google". There is no client-visible env, so the flag has to come from a
// server fn; gating the button on it keeps OSS deployments without Google
// credentials from showing a dead control. No middleware — the auth pages
// are pre-session, like resolveLanding.
export const getGoogleEnabled = createServerFn({ method: "GET" }).handler(
  ({ context }): { googleEnabled: boolean } => ({
    googleEnabled: resolveServerEnv(srv(context).env).googleEnabled,
  }),
);
