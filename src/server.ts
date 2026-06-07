import {
  createStartHandler,
  defaultStreamHandler,
} from "@tanstack/react-start/server";

import { api } from "./api";
import { reconcileControlPlane } from "./control/control-retention";
import { entitlementsOf, QuotaExceededError } from "./control/entitlements";
import { reconcileRetention } from "./control/project-reconciliation";
import { storeFor } from "./control/store-for";
import type {
  EventAppendInput,
  EventLogUsageSnapshot,
} from "./event-log-store";
import { asProjectId, type ProjectId } from "./ids";
import type { ServerRequestContext } from "./lib/server-context";
import type { ProjectUsageSnapshot } from "./project-store";

export { ProjectStore } from "./project-store";
export { EventLogStore } from "./event-log-store";
export { QuotaExceededError, entitlementsOf };
export type { EventAppendInput, EventLogUsageSnapshot };

declare module "@tanstack/react-start" {
  // Module augmentation requires `interface` (declaration merging); a
  // `type` cannot merge into the library's Register.
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Register {
    server: { requestContext: ServerRequestContext };
  }
}

const startHandler = createStartHandler(defaultStreamHandler);

// Non-UI Hono surface: Better Auth, MCP, OAuth discovery, healthcheck.
// Everything else (incl. TanStack Start server functions) is the app.
const API_PREFIXES = [
  "/api/auth/",
  "/api/ws/",
  "/api/v1/",
  "/mcp",
  "/.well-known/",
  "/healthz",
];

export type ServerRequestContextExtras = Readonly<
  Partial<Pick<ServerRequestContext, "entitlements">>
>;

export async function projectUsageSnapshot(
  env: Env,
  projectId: ProjectId | string,
): Promise<ProjectUsageSnapshot> {
  return storeFor(env, asProjectId(projectId)).usageSnapshot();
}

export function fetchWithContext(
  request: Request,
  env: Env,
  executionContext: ExecutionContext,
  extraContext: ServerRequestContextExtras = {},
): Response | Promise<Response> {
  const path = new URL(request.url).pathname;
  if (API_PREFIXES.some((p) => path === p || path.startsWith(p))) {
    return api.fetch(request, env, executionContext);
  }
  // Inject Cloudflare bindings as the request context (consumed by
  // sessionRequestMiddleware); hosted compositions may add entitlements.
  return startHandler(request, {
    context: { env, executionCtx: executionContext, ...extraContext },
  });
}

export default {
  async fetch(
    request: Request,
    env: Env,
    executionContext: ExecutionContext,
  ): Promise<Response> {
    return fetchWithContext(request, env, executionContext);
  },

  // Cron entry (wrangler.jsonc `triggers.crons`): the control-plane and
  // data-plane retention sweeps. Each is isolated so one failing does
  // not abort the other.
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _executionContext: ExecutionContext,
  ): Promise<void> {
    const results = await Promise.allSettled([
      reconcileControlPlane(env),
      reconcileRetention(env),
    ]);
    for (const r of results) {
      if (r.status === "rejected") console.error("[scheduled] sweep", r.reason);
    }
  },
};
