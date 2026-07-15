import { useRouter } from "@tanstack/react-router";
import { ChevronRight, Plus } from "lucide-react";
import { useState } from "react";

import { AgentPromptSection } from "@/components/collection/AgentPromptSection";
import { Field } from "@/components/Field";
import { BackLink } from "@/components/ui/BackLink";
import { Button } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { CopyButton } from "@/components/ui/CopyButton";
import { AbsoluteTime } from "@/components/ui/DateTime";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, EmptyState, listSurface } from "@/components/ui/Surface";
import { Tabs } from "@/components/ui/Tabs";
import { showToast } from "@/components/ui/Toast";
import { asCollectionSlug, type ProjectId } from "@/ids";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import { COLLECTION_SCOPE_PROMISE } from "@/lib/copy";
import { useSubmit } from "@/lib/forms";
import {
  type ApiKeyCreated,
  type ApiKeyMeta,
  type ConnectionKeysView,
  createApiKey,
  revokeApiKey,
} from "@/lib/server/api-keys";
import type { ColMetaResult } from "@/lib/server/collections";
import type { Role } from "@/lib/server/team.functions";

const KEY = "<YOUR_API_KEY>";

type Auth = "oauth" | "apikey";

const AUTH_OPTIONS: readonly {
  value: Auth;
  title: string;
  desc: string;
}[] = [
  {
    value: "oauth",
    title: "OAuth - Recommended",
    desc: "For clients with built-in sign-in like Claude. Nothing to copy or store.",
  },
  {
    value: "apikey",
    title: "API Key",
    desc: "For scripts, tools, or agents that can’t do the OAuth flow.",
  },
];

// Copy-paste connection recipes per client, tailored to the chosen
// auth AND to the bound Collection (server name =
// `corpus-<collectionSlug>` when arriving from "Connect this
// collection"; plain `corpus` from the generic connector page).
// OAuth recipes are the bare endpoint — the client runs the sign-in flow.
// API-key recipes add the bearer header with a placeholder (the secret is
// only shown once, on creation).
const TOOLS: readonly {
  id: string;
  label: string;
  caption: string;
  snippet: (url: string, auth: Auth, server: string) => string;
}[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    caption: "Run in your terminal.",
    snippet: (url, auth, server) =>
      auth === "oauth"
        ? `claude mcp add \\
  --transport http \\
  ${server} \\
  ${url}`
        : `claude mcp add \\
  --transport http \\
  ${server} \\
  ${url} \\
  --header "Authorization: Bearer ${KEY}"`,
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    caption: "Add to claude_desktop_config.json, then restart the app.",
    snippet: (url, auth, server) =>
      auth === "oauth"
        ? `{
  "mcpServers": {
    "${server}": {
      "command": "npx",
      "args": ["mcp-remote", "${url}"]
    }
  }
}`
        : `{
  "mcpServers": {
    "${server}": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "${url}",
        "--header",
        "Authorization: Bearer ${KEY}"
      ]
    }
  }
}`,
  },
  {
    id: "cursor",
    label: "Cursor",
    caption: "Add to ~/.cursor/mcp.json (or .cursor/mcp.json in a project).",
    snippet: (url, auth, server) =>
      auth === "oauth"
        ? `{
  "mcpServers": {
    "${server}": {
      "url": "${url}"
    }
  }
}`
        : `{
  "mcpServers": {
    "${server}": {
      "url": "${url}",
      "headers": { "Authorization": "Bearer ${KEY}" }
    }
  }
}`,
  },
  {
    id: "vscode",
    label: "VS Code",
    caption: "Add to .vscode/mcp.json in your workspace.",
    snippet: (url, auth, server) =>
      auth === "oauth"
        ? `{
  "servers": {
    "${server}": {
      "type": "http",
      "url": "${url}"
    }
  }
}`
        : `{
  "servers": {
    "${server}": {
      "type": "http",
      "url": "${url}",
      "headers": { "Authorization": "Bearer ${KEY}" }
    }
  }
}`,
  },
];

export function McpSetupPage({
  projectId,
  role,
  collection,
  url,
  connection,
  col,
}: Readonly<{
  projectId: ProjectId;
  role: Role;
  collection?: string | undefined;
  url: string;
  connection: ConnectionKeysView | undefined;
  col: ColMetaResult | undefined;
}>): React.ReactElement {
  const [auth, setAuth] = useState<Auth>("oauth");
  const [toolId, setToolId] = useState<string>(TOOLS[0]?.id ?? "");
  const tool = TOOLS.find((t) => t.id === toolId) ?? TOOLS[0];
  if (tool === undefined) return <div />;
  const isOwner = role === "owner";

  // `?collection=<slug>` pointing at a deleted / never-existed
  // Collection: every panel below would render a partial broken state
  // (BackLink to a 404'd /collections/<slug>, empty ApiKeysSection,
  // missing AgentPromptSection). Stop early with a single clear card so
  // the owner can correct the link or jump back to /collections.
  if (collection !== undefined && col !== undefined && !col.found) {
    return (
      <div className="pb-12">
        <BackLink
          to="/p/$projectId/collections"
          projectId={projectId}
          label="Collections"
        />
        <PageHeader
          title="Collection not found"
          subtitle={`No collection named ${collection} in this project. It may have been renamed or deleted.`}
        />
      </div>
    );
  }

  const mode =
    collection === undefined
      ? ({
          kind: "generic",
          serverName: "corpus",
          title: "MCP",
          subtitle:
            "One endpoint, two ways to authenticate. Either way, the agent only ever sees the one collection it’s connected to.",
        } as const)
      : ({
          kind: "collection",
          slug: asCollectionSlug(collection),
          serverName: `corpus-${collection}`,
          title: `Connect ${collection}`,
          subtitle: `${COLLECTION_SCOPE_PROMISE} Edit the collection anytime; agents see the change on their next call.`,
        } as const);
  const snippet = tool.snippet(url, auth, mode.serverName);

  return (
    <div className="pb-12">
      {mode.kind === "generic" ? (
        <BackLink
          to="/p/$projectId/collections"
          projectId={projectId}
          label="Collections"
        />
      ) : (
        <BackLink
          to="/p/$projectId/collections/$slug"
          projectId={projectId}
          slug={mode.slug}
          label={mode.slug}
        />
      )}
      <PageHeader title={mode.title} subtitle={mode.subtitle} />

      {/* Left: how to connect (endpoint + auth choice). Right: the exact
          thing to paste for the chosen client. Config on the left, the
          result on the right — same split as the collection builder. */}
      <div className="grid items-start gap-8 lg:grid-cols-2 lg:gap-10">
        <div className="space-y-6">
          <div>
            <div className="mb-2 text-sm font-medium text-slate-500">
              MCP endpoint
            </div>
            <Card className="flex items-center gap-3 p-4!">
              <code className="flex-1 truncate text-base">{url}</code>
              <CopyButton value={url} label="Copy MCP URL" />
            </Card>
          </div>

          <div>
            <div className="mb-2 text-sm font-medium text-slate-500">
              Authentication
            </div>
            <div
              role="radiogroup"
              aria-label="Authentication method"
              className="grid gap-2"
            >
              {AUTH_OPTIONS.map((o) => {
                const active = o.value === auth;
                return (
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setAuth(o.value)}
                    className={cn(
                      "flex items-start gap-3 rounded-md border px-4 py-3 text-left",
                      active
                        ? "border-blue-600 bg-blue-50"
                        : "border-slate-200 bg-white hover:bg-slate-50",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-1 grid size-4 shrink-0 place-items-center rounded-full border",
                        active ? "border-blue-600" : "border-slate-300",
                      )}
                    >
                      {active && (
                        <span className="size-2 rounded-full bg-blue-600" />
                      )}
                    </span>
                    <span>
                      <span className="block font-medium text-slate-900">
                        {o.title}
                      </span>
                      <span className="mt-0.5 block text-sm text-slate-500">
                        {o.desc}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div>
          <Tabs
            ariaLabel="MCP client"
            value={tool.id}
            onChange={setToolId}
            options={TOOLS.map((t) => ({ value: t.id, label: t.label }))}
          />
          <Card className="mt-4 space-y-3 p-4!">
            <p className="text-sm text-slate-500">{tool.caption}</p>
            <div className="relative">
              <CopyButton
                value={snippet}
                label="Copy to clipboard"
                className="absolute top-2 right-2"
              />
              <pre className="overflow-x-auto rounded-md border border-slate-200 bg-slate-50 p-4 pr-12 font-mono text-sm text-slate-900">
                {snippet}
              </pre>
            </div>
          </Card>

          {auth === "oauth" ? (
            <p className="mt-3 text-sm text-slate-500">
              Your client opens a sign-in (and consent) prompt on first connect
              — nothing to copy or store.
            </p>
          ) : (
            <p className="mt-3 text-sm text-slate-500">
              Replace <code className="font-mono">{KEY}</code> with one of the
              keys below.
            </p>
          )}
        </div>
      </div>

      {/* MCP is access; this section is the *trigger* that gets the agent
          to actually reach for it. Templated from the bound Collection's
          live name/description so the prompt stays accurate when the
          owner edits the collection — no second copy to keep aligned.
          Only renders when the collection is loaded; a not-found (race
          after delete) silently skips it. Collapsed behind <details> so
          the primary handoff (the snippet above) stays the focus. */}
      {mode.kind === "collection" && col?.found === true && (
        <CollapsibleSection
          className="mt-10"
          title="Tell the agent to use it"
          description="MCP gives the agent access. This prompt tells it when to reach for the collection. Paste it where your agent reads project guidance."
        >
          <AgentPromptSection
            serverName={mode.serverName}
            name={col.name}
            description={col.description}
          />
        </CollapsibleSection>
      )}

      {/* Visible regardless of the auth toggle: the toggle is a snippet-
          presentation choice, not a reason to hide existing keys.
          Collapsed by default; the snippet's "Replace <YOUR_API_KEY>"
          note is the signal to expand this. */}
      {mode.kind === "collection" && (
        <CollapsibleSection
          className="mt-6"
          title="API Keys"
          description={
            <>
              For headless clients that can't do OAuth. Each key is scoped to
              the <code className="font-mono">{mode.slug}</code> collection —
              agents using it see exactly this collection, nothing else.
            </>
          }
        >
          <ApiKeysSection
            projectId={projectId}
            connection={connection}
            isOwner={isOwner}
          />
        </CollapsibleSection>
      )}
    </div>
  );
}

// Collapsed section behind a native <details>: the snippet above is the
// primary handoff, so these secondary affordances (agent prompt, API keys)
// stay folded until the owner reaches for them.
function CollapsibleSection({
  title,
  description,
  className,
  children,
}: Readonly<{
  title: string;
  description: React.ReactNode;
  className?: string | undefined;
  children: React.ReactNode;
}>): React.ReactElement {
  return (
    <details className={cn("group border-t border-slate-200 pt-8", className)}>
      <summary className="flex cursor-pointer list-none items-center gap-2 text-lg font-semibold text-slate-900">
        {title}
        <ChevronRight
          aria-hidden
          className="size-4 shrink-0 text-slate-400 transition-transform group-open:rotate-90"
        />
      </summary>
      <p className="mt-0.5 text-sm text-slate-500">{description}</p>
      {children}
    </details>
  );
}

// `connection === undefined` covers two edge-case landings on this page
// where the canonical Connection has never been minted: a direct URL
// before "Connect this collection" ran, or a non-owner who can't mint it.
function ApiKeysSection({
  projectId,
  connection,
  isOwner,
}: Readonly<{
  projectId: ProjectId;
  connection: ConnectionKeysView | undefined;
  isOwner: boolean;
}>): React.ReactElement {
  return (
    <div className="mt-4">
      {connection === undefined ? (
        <EmptyState>
          No Connection for this collection yet. Click "Connect this collection"
          on the collection page first.
        </EmptyState>
      ) : (
        <ApiKeyManager
          projectId={projectId}
          connectionId={connection.connectionId}
          keys={connection.keys}
          isOwner={isOwner}
        />
      )}
    </div>
  );
}

function ApiKeyManager({
  projectId,
  connectionId,
  keys,
  isOwner,
}: Readonly<{
  projectId: ProjectId;
  connectionId: string;
  keys: readonly ApiKeyMeta[];
  isOwner: boolean;
}>) {
  const router = useRouter();
  const [created, setCreated] = useState<ApiKeyCreated>();
  const [creating, setCreating] = useState(false);

  if (created !== undefined) {
    return (
      <CreatedKey
        created={created}
        onDone={() => {
          setCreated(undefined);
          void router.invalidate();
        }}
      />
    );
  }

  // Members can't see keys at all (the listing is owner-scoped), so
  // "No API keys yet" would be a false claim for them — owner keys may
  // exist. Non-owners get only the ownership notice.
  if (!isOwner) {
    return (
      <p className="text-sm text-slate-500">
        API keys are managed by organization owners.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {keys.length === 0 ? (
        <EmptyState>
          No API keys yet. Generate one to connect a headless client.
        </EmptyState>
      ) : (
        <KeyList keys={keys} />
      )}
      {creating ? (
        <CreateForm
          projectId={projectId}
          connectionId={connectionId}
          onCancel={() => setCreating(false)}
          onCreated={(k) => {
            setCreating(false);
            setCreated(k);
          }}
        />
      ) : (
        <Button
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1.5!"
        >
          <Plus className="size-4" />
          New API Key
        </Button>
      )}
    </div>
  );
}

function KeyList({ keys }: Readonly<{ keys: readonly ApiKeyMeta[] }>) {
  return (
    <div className={listSurface()}>
      <table className="w-full text-base">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-left text-sm text-slate-500">
            <th className="px-4 py-3 font-medium">Name</th>
            <th className="px-4 py-3 font-medium">Key</th>
            <th className="px-4 py-3 font-medium">Created</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {keys.map((k) => (
            <tr key={k.id} className="hover:bg-slate-50">
              <td className="px-4 py-3 font-medium">{k.name}</td>
              <td className="px-4 py-3 font-mono text-sm text-slate-500">
                {k.tokenPrefix}…
              </td>
              <td className="px-4 py-3 text-slate-500 tabular-nums">
                <AbsoluteTime iso={k.createdAt} />
              </td>
              <td className="px-4 py-3 text-right">
                <RevokeButton id={k.id} name={k.name} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CreateForm({
  projectId,
  connectionId,
  onCancel,
  onCreated,
}: Readonly<{
  projectId: ProjectId;
  connectionId: string;
  onCancel: () => void;
  onCreated: (k: ApiKeyCreated) => void;
}>) {
  const [name, setName] = useState("");
  const {
    pending,
    error,
    run: submit,
  } = useSubmit(async () => {
    const k = await createApiKey({
      data: { name: name.trim(), connectionId, projectId },
    });
    track("api_key_created", { projectId, connectionId });
    onCreated(k);
  });

  return (
    <form
      className={listSurface("space-y-4 p-5")}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field label="Name" value={name} onChange={setName} />
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending || name.trim() === ""}>
          {pending ? "Generating…" : "Generate key"}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </form>
  );
}

function CreatedKey({
  created,
  onDone,
}: Readonly<{ created: ApiKeyCreated; onDone: () => void }>) {
  return (
    <div className={listSurface("space-y-3 p-5")}>
      <div className="text-base font-medium text-slate-900">
        Key “{created.name}” created
      </div>
      <p className="text-sm text-amber-700">
        Copy it now — this is the only time the full key is shown.
      </p>
      <div className="flex items-center gap-3">
        <code className="flex-1 truncate rounded-md bg-slate-50 px-3 py-2 font-mono text-sm">
          {created.token}
        </code>
        <CopyButton value={created.token} label="Copy API key" />
      </div>
      <Button variant="secondary" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}

function RevokeButton({ id, name }: Readonly<{ id: string; name: string }>) {
  const router = useRouter();
  const { pending, run } = useSubmit(async () => {
    const ok = await confirmDialog({
      title: `Revoke “${name}”?`,
      body: "Agents using this key will lose access immediately.",
      confirmLabel: "Revoke",
      tone: "danger",
    });
    if (!ok) return;
    await revokeApiKey({ data: { id } });
    showToast(`Key “${name}” revoked`);
    void router.invalidate();
  });
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => void run()}
      className="min-h-11 text-sm text-slate-500 hover:text-red-600 disabled:opacity-50"
    >
      Revoke
    </button>
  );
}
