import { z } from "zod";

import { CALLER_CHANNELS } from "../ids";
import {
  COLLECTION_EVENT_TYPES,
  DOCUMENT_EVENT_TYPES,
} from "../store/domain/change-events";

// The real-time channel's wire vocabulary + presence aggregation. Pure and
// zero-IO so it can be unit-tested without a DO or a socket.
//
// This is the one sanctioned real-time surface (distinct from the loader-only
// data path): the WebSocket carries ephemeral PRESENCE and "something
// changed, re-fetch" nudges — never document content, never durable events.

// Per-socket metadata, serialized onto the hibernating WebSocket so it
// survives the DO sleeping between messages.
export const SocketAttachment = z.object({
  userId: z.string(),
  userName: z.string(),
  docSlug: z.string().nullable(),
});
export type SocketMeta = Readonly<z.infer<typeof SocketAttachment>>;

// The only message a client sends: which document it is now viewing.
export const ClientMessage = z.object({
  type: z.literal("viewing"),
  docSlug: z.string().nullable(),
});

export type PresenceUser = Readonly<{
  userId: string;
  userName: string;
  docSlug: string | null;
}>;

// Review/project actions have no durable change-event counterpart; the
// document/collection actions are derived from the domain vocabulary so the
// two lists can never drift (a new event type is a compile-time addition here).
const REVIEW_ACTIONS = [
  "project.changed",
  "comment.created",
  "comment.replied",
  "comment.resolved",
  "suggestion.created",
  "suggestion.applied",
  "suggestion.rejected",
] as const;

const RealtimeActions = [
  ...DOCUMENT_EVENT_TYPES,
  ...COLLECTION_EVENT_TYPES,
  ...REVIEW_ACTIONS,
] as const;

export const RealtimeChange = z.object({
  area: z.enum(["project", "document", "collection", "review"]),
  action: z.enum(RealtimeActions),
  actorId: z.string().optional(),
  actorName: z.string().optional(),
  docSlug: z.string().optional(),
  docVersion: z.number().int().nonnegative().optional(),
  title: z.string().optional(),
  collectionSlug: z.string().optional(),
  channel: z.enum(CALLER_CHANNELS).optional(),
});
export type RealtimeChange = Readonly<z.infer<typeof RealtimeChange>>;

export const ServerMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("presence"),
    users: z.array(
      z.object({
        userId: z.string(),
        userName: z.string(),
        docSlug: z.string().nullable(),
      }),
    ),
  }),
  // `change` is best-effort enrichment for the toast/flash. A malformed or
  // unrecognized payload (e.g. a newer server emitting an action this client
  // doesn't know yet) must NOT drop the whole nudge: `.catch(undefined)`
  // degrades to a plain "something changed, re-fetch" so live refresh never
  // silently breaks.
  z.object({
    type: z.literal("changed"),
    change: RealtimeChange.optional().catch(undefined),
  }),
]);

// One entry per (user, document) — a user open in two tabs on the same doc
// shows once; the same user on two docs shows on each.
export function presenceFrom(
  metas: readonly SocketMeta[],
): readonly PresenceUser[] {
  const byKey = new Map<string, PresenceUser>();
  for (const m of metas) {
    if (m.userId === "") continue;
    byKey.set(`${m.userId}|${m.docSlug ?? ""}`, {
      userId: m.userId,
      userName: m.userName,
      docSlug: m.docSlug,
    });
  }
  return [...byKey.values()];
}
