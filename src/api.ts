import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { type Context, Hono } from "hono";
import {
  createLocalJWKSet,
  errors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";
import { z } from "zod";

import { getAuth } from "./auth.server";
import { API_KEY_PREFIX } from "./control/api-keys";
import {
  resolveApiKey,
  resolveConnection,
} from "./control/connection-resolution";
import { connectControlDb } from "./control/db";
import { connectionClaimKey } from "./control/oauth-selection";
import { resolveProjectById } from "./control/project-resolution";
import type { ConnectionRef } from "./control/refs";
import { storeFor } from "./control/store-for";
import {
  asDocumentSlug,
  asProjectId,
  callerRefFromApiKey,
  callerRefFromOAuth,
} from "./ids";
import { handleMcp, RpcSchema } from "./mcp";
import { scopedExecutor } from "./scoped-executor";
import { compact } from "./util";

// Shared MCP responder: parse the JSON-RPC envelope (the trust
// boundary), preflight the bound Collection, and dispatch through the
// scope-enforcing executor. Both auth paths (API-key bearer, OAuth JWT)
// resolve a `ConnectionRef` upstream and funnel here so MCP behavior
// has one home.
//
// The bound-Collection preflight is the fail-closed point: it has to
// live here because `handleMcp` emits only JSON-RPC and a missing
// Collection inside it maps to a JSON-RPC not-found inside an HTTP 200
// — an agent could read that as "empty Collection." Cost: one DO
// `collectionMembers` round-trip on every /mcp request, including
// `initialize`/`tools/list` that need no member set — the accepted
// price of failing closed at the transport. Not cached; a short
// per-credential TTL alongside the resolution path is the lever if
// this becomes hot.
async function respondMcp(
  env: Env,
  ref: ConnectionRef,
  request: Request,
): Promise<Response> {
  const parsed = RpcSchema.safeParse(
    await request.json().catch(() => undefined),
  );
  if (!parsed.success) {
    return Response.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "invalid JSON-RPC request" },
      },
      { status: 400 },
    );
  }
  const scope = await resolveScope(env, ref);
  if (scope === undefined) {
    // The Connection's bound Collection is gone — fail closed at the
    // transport. Never "therefore the whole Project," never a soft
    // JSON-RPC not-found that an agent could read as an empty Collection.
    return Response.json(
      { error: "connection's collection unavailable" },
      { status: 403 },
    );
  }
  const { store: inner, members } = scope;
  // Build the per-request CallerRef from the resolved Connection. The
  // api_key path populates `apiKeyId`; the OAuth path binds identity to
  // both the user and resolved Connection. That keeps proposal ownership
  // credential-scoped when one user authorizes multiple agents.
  const callerRef =
    ref.apiKeyId !== undefined
      ? callerRefFromApiKey(ref.apiKeyId)
      : callerRefFromOAuth(ref.userId, ref.connectionId);
  // Fire caller.connected exactly once per request — the
  // EventLogStore's idempotency_key collapses every subsequent
  // connect of the same caller to the original monotonic id so
  // the projection's "second distinct caller connected" signal
  // latches once and stays.
  await inner.recordCallerConnected(callerRef);
  const exec = scopedExecutor(inner, ref.collectionSlug, members, callerRef);
  return Response.json(await handleMcp(parsed.data, exec));
}

function bearer(authorization: string | undefined): string | undefined {
  const m = /^Bearer\s+(.+)$/iu.exec(authorization ?? "");
  return m?.[1]?.trim();
}

// The one place a Connection's bound-Collection scope is resolved: its
// Project store plus the resolved member-slug set. `undefined` = the
// bound Collection is gone, and every caller fails closed on that (never
// widening to the whole Project). Sharing it keeps the /mcp and REST
// surfaces from drifting on the tenant/scope boundary.
async function resolveScope(
  env: Env,
  ref: ConnectionRef,
): Promise<
  | Readonly<{ store: ReturnType<typeof storeFor>; members: readonly string[] }>
  | undefined
> {
  const store = storeFor(env, ref.projectId);
  const members = await store.collectionMembers(ref.collectionSlug);
  return members === undefined ? undefined : { store, members };
}

// RFC 9728 Protected Resource Metadata. The MCP spec REQUIRES it + a
// `WWW-Authenticate` pointing at it; the oauth-provider emits the
// challenge but serves no document. The helper returns the metadata
// object (not a handler), so we serve it ourselves — bare and
// `/mcp`-suffixed (the suffix is what the provider's challenge points
// at). Without this, discovery is broken: a client cannot walk a cold
// 401 → PRM → AS → DCR.
async function protectedResourceMetadata(env: Env): Promise<Response> {
  const base = env.BETTER_AUTH_URL;
  // The no-Auth variant: Better Auth's deep generics make a concrete
  // `Auth` instance fail the `T extends Auth` constraint, so we supply
  // the RFC 9728 fields explicitly instead of letting it auto-fill.
  // `resource` + `authorization_servers` are all a stock MCP client
  // needs to walk a cold 401 → PRM → AS metadata.
  const metadata = await oauthProviderResourceClient()
    .getActions()
    .getProtectedResourceMetadata({
      resource: `${base}/mcp`,
      authorization_servers: [base],
    });
  return Response.json(metadata);
}

// Per-isolate JWKS cache. Better Auth's signing keys rotate rarely, so
// resolving the key set on every /mcp request is wasteful — each
// resolution is an in-isolate auth-handler call plus a JSON parse. We
// memoize the resolver keyed by base URL and refetch only on a `kid`
// miss (a key rotation), mirroring jose's createRemoteJWKSet cooldown
// without its HTTP self-fetch — a Worker can't fetch its own hostname.
let cachedJwks:
  | Readonly<{ base: string; getKey: ReturnType<typeof createLocalJWKSet> }>
  | undefined;

async function resolveJwks(
  env: Env,
  base: string,
  refresh: boolean,
): Promise<ReturnType<typeof createLocalJWKSet>> {
  const cached = cachedJwks;
  if (!refresh && cached?.base === base) return cached.getKey;
  const set = await getAuth(env)
    .handler(new Request(`${base}/api/auth/jwks`))
    .then((r) => r.json<JSONWebKeySet>());
  const fresh = createLocalJWKSet(set);
  cachedJwks = { base, getKey: fresh };
  return fresh;
}

// Verify an OAuth access token against the cached JWKS. The token's
// `iss` is Better Auth's `ctx.context.baseURL` (BETTER_AUTH_URL + the
// `/api/auth` basePath), NOT the bare base. A `kid` miss means the keys
// rotated since we cached them — refetch once and retry before failing
// closed.
async function verifyOAuthJwt(
  env: Env,
  base: string,
  token: string,
): Promise<JWTPayload> {
  const options = { issuer: `${base}/api/auth`, audience: `${base}/mcp` };
  try {
    const getKey = await resolveJwks(env, base, false);
    return (await jwtVerify(token, getKey, options)).payload;
  } catch (e) {
    if (!(e instanceof errors.JWKSNoMatchingKey)) throw e;
    const getKey = await resolveJwks(env, base, true);
    return (await jwtVerify(token, getKey, options)).payload;
  }
}

const DocPushBody = z.object({
  markdown: z.string(),
  clientVersion: z.number().int().nonnegative(),
  title: z.string().optional(),
});

type ApiKeyScope = Readonly<{
  store: ReturnType<typeof storeFor>;
  members: ReadonlySet<string>;
  ref: ConnectionRef;
}>;

// Non-UI surface only. The web app's data flows through TanStack Start
// server functions (src/lib/server/*.ts); Hono carries auth, MCP, and
// OAuth discovery — the external/agent contract.
//
// Resolve an api-key bearer to its Project store AND the bound
// Collection's resolved member-slug set — the REST tenant *and* scope
// boundary in one step. An api-key is a Connection credential bound to a
// single Collection, so the CLI/automation surface must see exactly that
// Collection's documents, never the whole Project: the bearer's authority
// is the Collection, not its tenant. Shares `resolveScope` with the /mcp
// preflight and fails closed (403) when the bound Collection is gone —
// never widening to "therefore the whole Project." Returns the 401/403
// Response itself on failure so each route early-returns it unchanged.
async function apiKeyScope(
  c: Context<{ Bindings: Env }>,
): Promise<ApiKeyScope | Response> {
  const token = bearer(c.req.header("authorization"));
  const ref = token?.startsWith(API_KEY_PREFIX)
    ? await resolveApiKey(connectControlDb(c.env.DB), token)
    : undefined;
  if (ref === undefined) return c.json({ error: "unauthorized" }, 401);
  const scope = await resolveScope(c.env, ref);
  if (scope === undefined) {
    return c.json({ error: "connection's collection unavailable" }, 403);
  }
  return { store: scope.store, members: new Set(scope.members), ref };
}

export const api = new Hono<{ Bindings: Env }>()
  .get("/healthz", (c) => c.json({ ok: true }))
  // Real-time collaboration channel. Authenticate the upgrade (web session →
  // project member) HERE, then forward it to the per-Project DO, which owns
  // presence + change-nudge fan-out. The DO never sees an unauthenticated
  // socket; identity is passed as query params the Worker controls.
  .get("/api/ws/:projectId", async (c) => {
    if (c.req.raw.headers.get("upgrade") !== "websocket") {
      return c.text("expected a websocket upgrade", 426);
    }
    const projectId = c.req.param("projectId");
    const getSession = () =>
      getAuth(c.env).api.getSession({ headers: c.req.raw.headers });
    const session = await getSession();
    if (!session) return c.text("unauthorized", 401);
    const ref = await resolveProjectById(
      connectControlDb(c.env.DB),
      getSession,
      c.req.raw.headers,
      projectId,
    );
    if (ref === undefined) return c.text("forbidden", 403);

    const url = new URL(c.req.url);
    url.searchParams.set("uid", session.user.id);
    url.searchParams.set("name", session.user.name);
    return storeFor(c.env, asProjectId(projectId)).fetch(
      new Request(url, c.req.raw),
    );
  })
  // — REST surface for the CLI / automation (api-key bearer) ——————————
  // Every route scopes through the api-key's bound Collection: an agent
  // credential never reads or writes a document outside its Collection.
  // List filters to members; a non-member read 404s (no existence leak).
  // Writes: a member is updated; a wholly-new slug is CREATED into the
  // bound Collection; a slug that already exists outside it 403s (that is
  // another scope's document — the key may grow its own Collection, never
  // reach into one it doesn't already contain).
  .get("/api/v1/docs", async (c) => {
    const scope = await apiKeyScope(c);
    if (scope instanceof Response) return scope;
    const docs = await scope.store.listDocuments();
    return c.json({
      documents: docs
        .filter((d) => scope.members.has(d.slug))
        .map((d) => ({
          slug: d.slug,
          title: d.title,
          docVersion: d.docVersion,
        })),
    });
  })
  .get("/api/v1/docs/:slug", async (c) => {
    const scope = await apiKeyScope(c);
    if (scope instanceof Response) return scope;
    const slug = c.req.param("slug");
    if (!scope.members.has(slug)) return c.json({ error: "not found" }, 404);
    const d = await scope.store.getDocument(asDocumentSlug(slug));
    if (d === undefined) return c.json({ error: "not found" }, 404);
    return c.json({
      slug: d.slug,
      title: d.title,
      filename: d.filename,
      markdown: d.markdown,
      docVersion: d.docVersion,
    });
  })
  .put("/api/v1/docs/:slug", async (c) => {
    const scope = await apiKeyScope(c);
    if (scope instanceof Response) return scope;
    const slug = c.req.param("slug");
    const parsed = DocPushBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid body" }, 400);
    const save = compact({
      slug: asDocumentSlug(slug),
      markdown: parsed.data.markdown,
      title: parsed.data.title,
      clientVersion: parsed.data.clientVersion,
      changedBy: scope.ref.userId,
    });
    // A member is plainly updated; a non-member slug is created INTO the
    // bound collection (atomic save+attach, appended after the current
    // members). `members` is a snapshot, so the create path re-decides
    // inside its transaction: a slug that a racing create already landed
    // in this collection yields a retryable 409 (clientVersion decides),
    // and only a slug existing OUTSIDE the collection is `forbidden`.
    const r = scope.members.has(slug)
      ? await scope.store.saveDocument(save)
      : await scope.store.createDocumentInCollection(
          save,
          scope.ref.collectionSlug,
          scope.members.size,
        );
    if (r.ok) return c.json({ ok: true, docVersion: r.docVersion });
    if ("forbidden" in r) return c.json({ error: "forbidden" }, 403);
    if ("conflict" in r) {
      return c.json(
        { ok: false, conflict: true, currentVersion: r.currentVersion },
        409,
      );
    }
    if ("segmentCollision" in r) {
      return c.json({ ok: false, segmentCollision: true }, 409);
    }
    return c.json({ ok: false, rolledBack: true }, 409);
  })
  .get("/.well-known/oauth-authorization-server", (c) =>
    oauthProviderAuthServerMetadata(getAuth(c.env))(c.req.raw),
  )
  .get("/.well-known/openid-configuration", (c) =>
    oauthProviderOpenIdConfigMetadata(getAuth(c.env))(c.req.raw),
  )
  .get("/.well-known/oauth-protected-resource", (c) =>
    protectedResourceMetadata(c.env),
  )
  .get("/.well-known/oauth-protected-resource/mcp", (c) =>
    protectedResourceMetadata(c.env),
  )
  // Two MCP auth paths, mutually exclusive (body is read once):
  //   1. API-key bearer (`cck_…`) → its Connection. Detected by the
  //      prefix before any crypto/DB, so an OAuth JWT never hits this.
  //   2. OAuth bearer (JWKS-verified) → token.sub + the
  //      `${base}/connection` claim → resolveConnection. No claim /
  //      no resolvable Connection → 403 (the mandatory invariant).
  // Either way the resolved Connection's ProjectStore is the tenant
  // boundary and its Collection is the read scope.
  .all("/mcp", async (c) => {
    const token = bearer(c.req.header("authorization"));
    if (token?.startsWith(API_KEY_PREFIX)) {
      const ref = await resolveApiKey(connectControlDb(c.env.DB), token);
      if (ref === undefined) {
        return Response.json({ error: "invalid api key" }, { status: 401 });
      }
      return respondMcp(c.env, ref, c.req.raw);
    }
    // OAuth bearer (JWKS-verified) → token.sub + the `${base}/connection`
    // claim → resolveConnection. We verify in-process rather than with
    // better-auth's `mcpHandler`: that fetches `${base}/api/auth/jwks` over
    // HTTP, but a Cloudflare Worker can't fetch its own hostname (the
    // subrequest loops back to this same Worker and is dropped), so the
    // self-fetch fails on a single-origin deploy. Pulling the JWKS straight
    // from the auth handler keeps verification fully in-isolate.
    const base = c.env.BETTER_AUTH_URL;
    // 401 with the MCP resource-metadata challenge so clients (re)discover the
    // authorization server and start the OAuth flow. Mirrors the value
    // better-auth's mcpHandler emits for an UNAUTHORIZED access token.
    const challenge = (): Response =>
      new Response(JSON.stringify({ error: "invalid_token" }), {
        status: 401,
        headers: {
          "content-type": "application/json",
          "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
        },
      });
    if (token === undefined) return challenge();
    let jwt: JWTPayload;
    try {
      jwt = await verifyOAuthJwt(c.env, base, token);
    } catch {
      return challenge();
    }
    const userId = typeof jwt.sub === "string" ? jwt.sub : "";
    const claim = jwt[connectionClaimKey(base)];
    const connectionId = typeof claim === "string" ? claim : "";
    const ref = await resolveConnection(connectControlDb(c.env.DB), {
      userId,
      connectionId,
    });
    if (ref === undefined) {
      return Response.json({ error: "no connection" }, { status: 403 });
    }
    return respondMcp(c.env, ref, c.req.raw);
  })
  // Better Auth owns /api/auth/* (signup, signin, session, signout).
  .all("/api/auth/*", (c) => getAuth(c.env).handler(c.req.raw));
