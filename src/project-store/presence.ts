import { z } from "zod";

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
