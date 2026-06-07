import { createMiddleware } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";

import { getAuth } from "@/auth";
import { connectControlDb } from "@/control/db";
import { resolveProjectById } from "@/control/project-resolution";
import { assertServerContext, UnauthorizedError } from "@/lib/server-context";

const STATIC_ASSET = /\/[^/?]+\.[a-z\d]+$/iu;

function skipSession(pathname: string): boolean {
  return (
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/assets/") ||
    STATIC_ASSET.test(pathname)
  );
}

export const sessionRequestMiddleware = createMiddleware({
  type: "request",
}).server(async ({ context, next, pathname }) => {
  const c = assertServerContext(context);
  if (skipSession(pathname)) {
    return next({ context: { authSession: undefined } });
  }
  try {
    const session = await getAuth(c.env).api.getSession({
      headers: new Headers(getRequestHeaders()),
    });
    return await next({ context: { authSession: session ?? undefined } });
  } catch (error) {
    console.error("[session] auth error", error);
    return next({ context: { authSession: undefined } });
  }
});

export const authMiddleware = createMiddleware({ type: "function" }).server(
  async ({ next, context }) => {
    const c = assertServerContext(context);
    if (c.authSession === undefined) {
      throw new UnauthorizedError("Authentication required");
    }
    return next({ context: { authSession: c.authSession } });
  },
);

// The URL names the project, not the session. The inputValidator merges
// `projectId` into every consuming server fn's `data` type, so omitting
// it is a compile error, not a runtime 401. Self-contained (re-checks
// the session) so it composes without authMiddleware. The
// membership-scoped resolve is the tenant boundary.
//
// `looseObject`, not `object`: a strict object strips unknown keys, so
// it would drop the consuming fn's own fields (e.g. `slug`) before that
// fn's inputValidator runs. Loose validates `projectId` and passes the
// rest through.
export const projectMiddleware = createMiddleware({ type: "function" })
  .validator(z.looseObject({ projectId: z.string().min(1) }))
  .server(async ({ next, context, data }) => {
    const c = assertServerContext(context);
    const userId = c.authSession?.user.id;
    if (userId === undefined) {
      throw new UnauthorizedError("Authentication required");
    }
    const ref = await resolveProjectById(
      connectControlDb(c.env.DB),
      () => Promise.resolve({ user: { id: userId } }),
      new Headers(getRequestHeaders()),
      data.projectId,
    );
    if (ref === undefined) {
      throw new UnauthorizedError("No project");
    }
    return next({ context: { project: ref } });
  });
