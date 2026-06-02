import type { ProjectRef } from "@/control/refs";
import { storeFor } from "@/control/store-for";
import { ForbiddenError, UnauthorizedError } from "@/errors";
import { asProjectId, asUserId, type UserId } from "@/ids";
import type { ServerRequestContext } from "@/lib/server-context";
import type { ProjectStore } from "@/project-store";

export function storeOf(
  c: ServerRequestContext,
): DurableObjectStub<ProjectStore> {
  // projectMiddleware guarantees `c.project`; the "" fallback is dead
  // defensiveness kept type-correct via the brand constructor.
  return storeFor(c.env, c.project?.projectId ?? asProjectId(""));
}

export const authedUserId = (c: ServerRequestContext): UserId =>
  asUserId(c.authSession?.user.id ?? "");

// The actor id stamped on change events / version nodes (the `changedBy`
// field across documents/collections/folders/team writes). projectMiddleware
// guarantees `c.project`; the "" fallback mirrors authedUserId's dead-but-
// type-correct defensiveness. A plain string, not a branded UserId — it
// crosses the DO RPC boundary as the change-event author.
export const changedBy = (c: ServerRequestContext): string =>
  c.project?.userId ?? "";

// Project-owner gate for admin server fns. Pair with `projectMiddleware`
// so `c.project` is populated. The forbidden message is per-action so
// the rejection is informative ("Only an org owner can mint API keys",
// not a generic "forbidden"). Returns the resolved ref so the caller
// can chain off it without re-narrowing.
export function requireProjectOwner(
  ref: ProjectRef | undefined,
  forbiddenMessage: string,
): ProjectRef {
  if (ref === undefined) throw new UnauthorizedError("No project");
  if (ref.role !== "owner") throw new ForbiddenError(forbiddenMessage);
  return ref;
}
