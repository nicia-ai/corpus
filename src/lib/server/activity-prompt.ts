import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { eventLogFor } from "@/control/event-log-for";
import { asProjectId } from "@/ids";
import { authMiddleware, projectMiddleware } from "@/lib/middleware";
import { assertServerContext as srv } from "@/lib/server-context";
import {
  encodeEvent,
  events as buildEvent,
  eventType as eventTypeOf,
  idempotencyKey,
  INSTRUMENTATION_EVENT_SCHEMA_VERSION,
} from "@/store/domain/instrumentation-events";

// Post-activation prompt submission. Lands a `prompt.answered` event
// in the per-Project event stream. The EventLogStore's idempotency_key
// (`prompt.answered:<answeredBy>`) means one answer per team member;
// a re-submit by the same user is deduped at the DB.

const promptBetSchema = z.enum([
  "shared-prompts-skills",
  "version-quality-measurement",
  "off-laptop-reactivity",
  "policy-change-approval",
  "none",
]);

export const recordPromptAnswer = createServerFn({ method: "POST" })
  .middleware([authMiddleware, projectMiddleware])
  .validator(
    z.object({
      bet: promptBetSchema,
      // Accepted but not in the event payload: the prompt is
      // project-scoped, not collection-scoped. Held so a later UI
      // evolution can show "you answered from collection X" without
      // changing the API.
      collectionSlug: z.string().min(1).optional(),
      // projectMiddleware consumes this; declare it so the input
      // validator does not strip it before the middleware runs.
      projectId: z.string().min(1),
    }),
  )
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const cx = srv(context);
    const answeredBy = cx.authSession?.user.id ?? "";
    const event = buildEvent.promptAnswered({
      bet: data.bet,
      answeredBy,
    });
    const projectId = cx.project?.projectId ?? asProjectId("");
    try {
      await eventLogFor(cx.env, projectId).append({
        schemaVersion: INSTRUMENTATION_EVENT_SCHEMA_VERSION,
        projectId,
        idempotencyKey: idempotencyKey(event),
        eventType: eventTypeOf(event),
        payload: encodeEvent(event),
      });
    } catch (err) {
      console.error("[activity-prompt] event-stream append failed", err);
    }
    return { ok: true };
  });
