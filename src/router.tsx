import { createRouter } from "@tanstack/react-router";

import { RouteError, RoutePending } from "@/components/ui/RouteFallbacks";

import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    routeTree,
    defaultPreload: "intent",
    defaultErrorComponent: RouteError,
    defaultPendingComponent: RoutePending,
    scrollRestoration: true,
  });
}

declare module "@tanstack/react-router" {
  // Module augmentation requires `interface` (declaration merging).
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
