/// <reference types="vite/client" />
import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
  useRouterState,
} from "@tanstack/react-router";

import { Analytics } from "@/components/Analytics";
import { ConfirmHost } from "@/components/ui/ConfirmDialog";
import { ToastHost } from "@/components/ui/Toast";
import { Wordmark } from "@/components/ui/Wordmark";
import { authClient } from "@/lib/auth-client";
import { getAnalyticsConfig } from "@/lib/server/analytics-config";
import appCss from "@/styles.css?url";

// App-wide banner shown while a platform admin is impersonating another
// user (Better Auth sets session.impersonatedBy). Keeps the operator
// aware and one click from exiting — important since destructive actions
// would otherwise run as the target.
function ImpersonationBanner(): React.ReactElement | null {
  const { data } = authClient.useSession();
  if (!data?.session.impersonatedBy) return null;
  return (
    <div className="flex items-center justify-center gap-3 bg-amber-500 px-4 py-1.5 text-sm font-medium text-amber-950">
      <span>Impersonating {data.user.email}</span>
      <button
        type="button"
        className="rounded bg-amber-950/10 px-2 py-0.5 hover:bg-amber-950/20"
        onClick={() => {
          void authClient.admin.stopImpersonating().finally(() => {
            window.location.href = "/admin";
          });
        }}
      >
        Stop impersonating
      </button>
    </div>
  );
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Corpus" },
    ],
    links: [
      {
        rel: "icon",
        type: "image/svg+xml",
        href: "/favicon.svg",
        sizes: "any",
      },
      { rel: "stylesheet", href: appCss },
    ],
  }),
  // Resolve the publishable PostHog config once on the server so the
  // browser can boot analytics without a client-visible env. Null when
  // unconfigured — the Analytics component then stays dark.
  loader: () => getAnalyticsConfig(),
  component: RootDocument,
});

// Project-scoped pages (`/p/$projectId/...`) render their own full
// app shell (sidebar + switcher) from the `p.$projectId` layout.
// Everything else — sign-in, sign-up, invite, the `/` resolver/first-run
// — is a focused pre-project surface: a centered card, no app nav (its
// nav would assume a resolved project the visitor may not have).
function RootDocument() {
  const analytics = Route.useLoaderData();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // /p/* and /admin render their own full-width layout; everything else
  // (sign-in, invite, first-run) gets the centered pre-project card.
  const scoped = pathname.startsWith("/p/") || pathname.startsWith("/admin");

  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        <ImpersonationBanner />
        {scoped ? (
          <Outlet />
        ) : (
          <div className="flex min-h-screen flex-col items-center justify-center p-4">
            <Wordmark size="lg" className="mb-6" />
            <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
              <Outlet />
            </div>
          </div>
        )}
        <ToastHost />
        <ConfirmHost />
        <Analytics config={analytics} />
        <Scripts />
      </body>
    </html>
  );
}
