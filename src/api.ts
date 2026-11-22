import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { Hono } from "hono";
import {
  createLocalJWKSet,
  errors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";

import { bearer, resolveScope } from "./api-scope";
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
import { docsRoutes } from "./docs-rest";
import {
  embassyFile,
  embassyGet,
  embassyEdit,
  embassySection,
  embassySuggest,
} from "./embassy/http";
import { serveFile, uploadFile } from "./files/http";
import { objectStoreFor } from "./files/object-store-for";
import { filesRoutes } from "./files-rest";
import { asProjectId, callerRefFromApiKey, callerRefFromOAuth } from "./ids";
import { handleMcp, RpcSchema } from "./mcp";
import { scopedExecutor } from "./scoped-executor";

// Shared MCP responder: parse the JSON-RPC envelope (the trust
// boundary), preflight the bound Corpus, and dispatch through the
// scope-enforcing executor. Both auth paths (API-key bearer, OAuth JWT)
// resolve a `ConnectionRef` upstream and funnel here so MCP behavior
// has one home.
//
// The bound-Corpus preflight is the fail-closed point: it has to
// live here because `handleMcp` emits only JSON-RPC and a missing
// Corpus inside it maps to a JSON-RPC not-found inside an HTTP 200
// — an agent could read that as "empty Corpus." Cost: one DO
// `corpusMembers` round-trip on every /mcp request, including
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
    // The Connection's bound Corpus is gone — fail closed at the
    // transport. Never "therefore the whole Project," never a soft
    // JSON-RPC not-found that an agent could read as an empty Corpus.
    return Response.json(
      { error: "connection's corpus unavailable" },
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
  const exec = scopedExecutor(inner, ref.corpusSlug, members, callerRef, {
    baseUrl: env.BETTER_AUTH_URL,
    projectId: ref.projectId,
    objects: objectStoreFor(env),
  });
  return Response.json(await handleMcp(parsed.data, exec));
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

export const api = new Hono<{ Bindings: Env }>()
  .get("/healthz", (c) => c.json({ ok: true }))
  .get("/s/:token", (c) => embassyGet(c))
  .get("/s/:token/f/:hash", (c) => embassyFile(c))
  .post("/s/:token/suggest", (c) => embassySuggest(c))
  .put("/s/:token", (c) => embassyEdit(c))
  .put("/s/:token/section", (c) => embassySection(c))
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
  // Uploaded images and attachments (see src/files/http.ts): a session-authed
  // upload (checked same-origin there, since Hono routes bypass the server-fn
  // CSRF middleware) and the membership-gated read.
  .put("/api/files", (c) => uploadFile(c))
  .get("/api/files/:projectId/:hash", (c) => serveFile(c))
  .route("/", docsRoutes)
  .route("/", filesRoutes)
  .get("/.well-known/oauth-authorization-server", (c) =>
    // See `asBetterAuthPlugin` in better-auth-plugin-compat.ts: widening the
    // oauth-provider plugin to `BetterAuthPlugin` erases the literal
    // endpoint names from `getAuth(...).api`, including the two this
    // helper needs. Its own parameter type only asks for those two methods
    // to exist and be callable — reasserting through it, rather than
    // inventing the shape by hand, tracks any future signature change.
    oauthProviderAuthServerMetadata(
      getAuth(c.env) as unknown as Parameters<
        typeof oauthProviderAuthServerMetadata
      >[0],
    )(c.req.raw),
  )
  .get("/.well-known/openid-configuration", (c) =>
    oauthProviderOpenIdConfigMetadata(
      getAuth(c.env) as unknown as Parameters<
        typeof oauthProviderOpenIdConfigMetadata
      >[0],
    )(c.req.raw),
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
  // boundary and its Corpus is the read scope.
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
