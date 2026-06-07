import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { eventLogFor } from "@/control/event-log-for";
import { asCollectionSlug, asProjectId } from "@/ids";
import { projectMiddleware } from "@/lib/middleware";
import {
  buildCollectionActivity,
  type ActivityAgentRow,
  type ActivityDTO,
  type ActivityStatus,
  type RecentEventRow,
} from "@/lib/server/activity-view";
import { storeOf } from "@/lib/server/shared";
import {
  assertServerContext as srv,
  type ServerRequestContext,
} from "@/lib/server-context";

function eventLogOf(c: ServerRequestContext) {
  return eventLogFor(c.env, c.project?.projectId ?? asProjectId(""));
}

export type { ActivityAgentRow, ActivityDTO, ActivityStatus, RecentEventRow };

export const getCollectionActivity = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .validator(
    z.object({
      slug: z.string().min(1),
      // projectMiddleware consumes this; declare it so the input
      // validator does not strip it before the middleware runs.
      projectId: z.string().min(1),
    }),
  )
  .handler(async ({ data, context }): Promise<ActivityDTO> => {
    const cx = srv(context);
    return buildCollectionActivity({
      slug: asCollectionSlug(data.slug),
      mcpUrl: `${cx.env.BETTER_AUTH_URL}/mcp`,
      store: storeOf(cx),
      log: eventLogOf(cx),
    });
  });
