import { createCsrfMiddleware, createStart } from "@tanstack/react-start";

import { sessionRequestMiddleware } from "@/lib/middleware";

// Server functions are the web app's entire data layer: cookie-authenticated,
// same-origin RPC POST endpoints. Defining a startInstance opts us out of
// TanStack's default CSRF middleware, so we re-add it explicitly. Runs before
// the session middleware to reject cross-site requests before any auth/DB work.
const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

export const startInstance = createStart(() => ({
  defaultSsr: true,
  requestMiddleware: [csrfMiddleware, sessionRequestMiddleware],
}));
