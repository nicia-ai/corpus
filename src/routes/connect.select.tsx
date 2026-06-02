import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState, listSurface } from "@/components/ui/Surface";
import { asConnectionId } from "@/ids";
import { authClient } from "@/lib/auth-client";
import { COLLECTION_SCOPE_PROMISE } from "@/lib/copy";
import { useSubmit } from "@/lib/forms";
import {
  commitConnectionSelection,
  listMyAdministeredConnections,
  type PickerRow,
  readPendingConnectFn,
} from "@/lib/server/connections";

// The post-login Connection picker — the ONLY place a Connection binds
// to an OAuth grant. Better Auth's `postLogin.shouldRedirect` lands the
// owner here (with the signed authorization query in the URL); on pick we
// write the handshake-keyed selection, then hand back to Better Auth via
// `authClient.oauth2.continue({ postLogin: true })`. The `oauthProviderClient`
// fetch hook attaches the signed `oauth_query` from the URL so the server
// re-establishes the in-flight request, `consentReferenceId` reads our
// selection, and the client `redirectPlugin` follows the returned redirect
// into the consent leg. NOT project-scoped — a Connection self-describes
// its Project, so the picker spans every Connection the signed-in owner
// administers.
export const Route = createFileRoute("/connect/select")({
  component: SelectConnection,
  loader: async () => {
    const [connections, pending] = await Promise.all([
      listMyAdministeredConnections(),
      readPendingConnectFn(),
    ]);
    return { connections, pendingConnectionId: pending.connectionId };
  },
});

function SelectConnection() {
  const { connections, pendingConnectionId } = Route.useLoaderData();
  // Pre-select the userId-keyed pending-connect hint (the Collection-
  // page "Connect this collection" click that may have happened before
  // the client's OAuth flow existed). NOT auto-bound — the user still
  // confirms; the hint is a *picker default*.
  const initial =
    pendingConnectionId !== undefined &&
    connections.some((c) => c.connectionId === pendingConnectionId)
      ? pendingConnectionId
      : (connections[0]?.connectionId ?? asConnectionId(""));
  const [picked, setPicked] = useState(initial);

  const {
    pending,
    error,
    run: submit,
  } = useSubmit(async () => {
    const r = await commitConnectionSelection({
      data: { connectionId: picked, oauthQuery: window.location.search },
    });
    if (!r.ok) {
      throw new Error(
        "This page was opened outside an in-flight authorization. Restart the connect flow from your agent client.",
      );
    }
    const cont = await authClient.oauth2.continue({ postLogin: true });
    if (cont.error) {
      throw new Error(
        cont.error.message ?? "Could not continue the authorization.",
      );
    }
    // On success the client redirectPlugin has already navigated to the
    // consent leg via the returned { redirect, url }.
  });

  // Empty case: surface immediately instead of letting the OAuth flow
  // fall through to a claimless token and a 403 at the next /mcp call.
  const empty = connections.length === 0;
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Choose a collection for this agent"
        subtitle={
          empty
            ? "No collections are set up for agent access yet. Open a collection in Corpus and click “Connect this collection” first."
            : COLLECTION_SCOPE_PROMISE
        }
      />
      {empty ? (
        <EmptyState>
          Open a collection in Corpus and click{" "}
          <strong>Connect this collection</strong>, then restart this
          agent&rsquo;s sign-in.
        </EmptyState>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className={listSurface("divide-y divide-slate-200")}>
            {connections.map((c) => (
              <ConnectionOption
                key={c.connectionId}
                connection={c}
                checked={c.connectionId === picked}
                onChange={() => setPicked(c.connectionId)}
              />
            ))}
          </div>
          {error && <p className="text-base text-red-600">{error}</p>}
          <Button type="submit" disabled={pending || picked === ""}>
            {pending ? "Connecting…" : "Grant access to this collection"}
          </Button>
        </form>
      )}
    </div>
  );
}

function ConnectionOption({
  connection: c,
  checked,
  onChange,
}: Readonly<{
  connection: PickerRow;
  checked: boolean;
  onChange: () => void;
}>) {
  return (
    <label className="flex cursor-pointer items-start gap-3 px-4 py-3 hover:bg-slate-50">
      <input
        type="radio"
        name="connection"
        checked={checked}
        onChange={onChange}
        className="mt-1"
      />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-slate-900">{c.collectionSlug}</div>
        <div className="text-sm text-slate-500">
          {c.projectName}
          {c.isDefaultForCollection ? "" : ` · ${c.name}`}
        </div>
      </div>
    </label>
  );
}
