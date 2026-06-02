import { createFileRoute, useRouterState } from "@tanstack/react-router";

import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState, listSurface } from "@/components/ui/Surface";
import { authClient } from "@/lib/auth-client";
import { useSubmit } from "@/lib/forms";

// The OAuth consent screen (Better Auth `consentPage`). Better Auth lands
// the signed-in user here with the signed authorization query in the URL
// after the Connection picker. We never POST the query ourselves: the
// `oauthProviderClient` fetch hook attaches it as `oauth_query` to
// `authClient.oauth2.consent`, the server verifies the signature and
// re-establishes the request, and the client `redirectPlugin` follows the
// returned `{ redirect, url }` — an accept lands the authorization code at
// the agent client's callback, a deny lands an `access_denied` error there.
export const Route = createFileRoute("/consent")({
  component: Consent,
});

// Friendly labels for the standard OIDC/MCP scopes; unknown scopes fall
// back to their raw name so a new scope is never silently hidden.
const SCOPE_LABELS: Readonly<Record<string, string>> = {
  openid: "Confirm your identity",
  profile: "Read your basic profile",
  email: "Read your email address",
  offline_access: "Stay connected when you're away",
};

function Consent(): React.ReactElement {
  const searchStr = useRouterState({ select: (s) => s.location.searchStr });
  const params = new URLSearchParams(searchStr);
  const signed = params.has("sig");
  const scopes = (params.get("scope") ?? "").split(/\s+/u).filter(Boolean);

  const { pending, error, run } = useSubmit(async (accept: boolean) => {
    const r = await authClient.oauth2.consent({ accept });
    if (r.error) {
      throw new Error(r.error.message ?? "Could not record your decision.");
    }
    // On success the client redirectPlugin has navigated to the returned
    // redirect (authorization code on accept, access_denied on deny).
  });

  if (!signed) {
    return (
      <div>
        <PageHeader title="Authorize access" />
        <EmptyState>
          This page was opened outside an authorization request. Start the
          connect flow from your agent client.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Authorize access"
        subtitle="An agent client is requesting access to your Corpus account."
      />
      {scopes.length > 0 && (
        <ul className={listSurface("divide-y divide-slate-200")}>
          {scopes.map((scope) => (
            <li key={scope} className="px-4 py-3">
              <div className="font-medium text-slate-900">
                {SCOPE_LABELS[scope] ?? scope}
              </div>
              <div className="font-mono text-sm text-slate-500">{scope}</div>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-base text-red-600">{error}</p>}
      <div className="flex justify-between gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={() => void run(false)}
          disabled={pending}
        >
          Deny
        </Button>
        <Button type="button" onClick={() => void run(true)} disabled={pending}>
          {pending ? "Authorizing…" : "Allow access"}
        </Button>
      </div>
    </div>
  );
}
