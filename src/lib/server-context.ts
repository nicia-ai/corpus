import type { Entitlements } from "@/control/entitlements";
import type { ProjectRef } from "@/control/refs";
import { MissingContextError } from "@/errors";

export { MissingContextError, UnauthorizedError } from "@/errors";

type AuthSession = Readonly<{
  // `role` is the Better Auth admin-plugin platform role ("admin" | "user" |
  // null); present on the resolved session, surfaced here so the site-admin
  // gate reads the request-scoped session instead of re-resolving it.
  user: Readonly<{
    id: string;
    name?: string;
    email?: string;
    role?: string | null;
  }>;
}>;

// Matches the requestContext module augmentation in src/server.ts.
export type ServerRequestContext = Readonly<{
  env: Env;
  executionCtx: ExecutionContext;
  authSession?: AuthSession | undefined;
  project?: ProjectRef | undefined;
  // Never injected in OSS (→ `unlimitedEntitlements` via `entitlementsOf`).
  // A hosted composition wraps the handler and injects a real impl here.
  entitlements?: Entitlements | undefined;
}>;

export function isServerContext(
  context: unknown,
): context is ServerRequestContext {
  return (
    typeof context === "object" &&
    context !== null &&
    "env" in context &&
    typeof (context as ServerRequestContext).env === "object" &&
    "executionCtx" in context
  );
}

export function assertServerContext(context: unknown): ServerRequestContext {
  if (!isServerContext(context)) {
    throw new MissingContextError("Cloudflare bindings unavailable");
  }
  return context;
}
