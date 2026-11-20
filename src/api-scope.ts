import type { Context } from "hono";

import { API_KEY_PREFIX } from "./control/api-keys";
import { resolveApiKey } from "./control/connection-resolution";
import { connectControlDb } from "./control/db";
import type { ConnectionRef } from "./control/refs";
import { storeFor } from "./control/store-for";
import type { Grant } from "./grant";
import { callerRefFromApiKey, type CallerRef } from "./ids";
import { corpusIsServed } from "./store/domain/corpus-drive";

// The tenant and scope boundary shared by the REST (`/api/v1`) and MCP
// (`/mcp`) transports: a bearer token resolved to its Project store and the
// bound Corpus's member set.

export function bearer(authorization: string | undefined): string | undefined {
  const m = /^Bearer\s+(.+)$/iu.exec(authorization ?? "");
  return m?.[1]?.trim();
}

// The one place a Connection's bound-Corpus scope is resolved: its
// Project store plus the resolved member-slug set. `undefined` = the
// bound Corpus is gone, and every caller fails closed on that (never
// widening to the whole Project). Sharing it keeps the /mcp and REST
// surfaces from drifting on the tenant/scope boundary.
export async function resolveScope(
  env: Env,
  ref: ConnectionRef,
): Promise<
  | Readonly<{ store: ReturnType<typeof storeFor>; members: readonly string[] }>
  | undefined
> {
  // The default corpus is the drafts space: never served, whatever a
  // Connection row written before that rule may still say.
  if (!corpusIsServed(ref.corpusSlug)) return undefined;
  const store = storeFor(env, ref.projectId);
  const members = await store.corpusMembers(ref.corpusSlug);
  return members === undefined ? undefined : { store, members };
}

// What an API key may do. An api-key `ConnectionRef` always carries its
// grant; the `read` fallback only makes a missing one fail closed.
export const FALLBACK_KEY_GRANT: Grant = "read";

export type ApiKeyScope = Readonly<{
  store: ReturnType<typeof storeFor>;
  members: ReadonlySet<string>;
  ref: ConnectionRef;
  grant: Grant;
  // Who a proposal from this key is attributed to: the key itself, which
  // resolves to its human owner everywhere an author is shown.
  callerRef: CallerRef;
}>;

// Resolve an api-key bearer to its Project store AND the bound
// Corpus's resolved member-slug set — the REST tenant *and* scope
// boundary in one step. An api-key is a Connection credential bound to a
// single Corpus, so the CLI/automation surface must see exactly that
// Corpus's documents, never the whole Project: the bearer's authority
// is the Corpus, not its tenant. Fails closed (403) when the bound Corpus
// is gone — never widening to "therefore the whole Project." Returns the
// 401/403 Response itself on failure so each route early-returns it
// unchanged.
export async function apiKeyScope(
  c: Context<{ Bindings: Env }>,
): Promise<ApiKeyScope | Response> {
  const token = bearer(c.req.header("authorization"));
  const ref = token?.startsWith(API_KEY_PREFIX)
    ? await resolveApiKey(connectControlDb(c.env.DB), token)
    : undefined;
  if (ref?.apiKeyId === undefined) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const scope = await resolveScope(c.env, ref);
  if (scope === undefined) {
    return c.json({ error: "connection's corpus unavailable" }, 403);
  }
  return {
    store: scope.store,
    members: new Set(scope.members),
    ref,
    grant: ref.apiKeyGrant ?? FALLBACK_KEY_GRANT,
    callerRef: callerRefFromApiKey(ref.apiKeyId),
  };
}
