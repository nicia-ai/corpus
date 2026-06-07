import { useEffect, useRef, useState } from "react";
import { z } from "zod";

import type { ProjectId } from "@/ids";

export type PresenceUser = Readonly<{
  userId: string;
  userName: string;
  docSlug: string | null;
}>;

const ServerMessage = z.discriminatedUnion("type", [
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
  z.object({ type: z.literal("changed") }),
]);

const RETRY_MS = 2000;

// Subscribe to the project's real-time channel for the open document: returns
// the live presence list and invokes `onChanged` whenever the project signals
// a write so the caller can re-fetch. This is the ONE sanctioned useEffect
// subscription — it owns a socket, not loader data.
export function useCollab(
  projectId: ProjectId,
  docSlug: string,
  onChanged: () => void,
): readonly PresenceUser[] {
  const [presence, setPresence] = useState<readonly PresenceUser[]>([]);
  // Keep the latest callback without tearing down the socket each render
  // (synced in an effect, never written during render).
  const onChangedRef = useRef(onChanged);
  useEffect(() => {
    onChangedRef.current = onChanged;
  });

  useEffect(() => {
    let closed = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = (): void => {
      if (closed) return;
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(
        `${scheme}://${window.location.host}/api/ws/${projectId}?doc=${encodeURIComponent(docSlug)}`,
      );
      socket = ws;
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "viewing", docSlug }));
      };
      ws.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        let raw: unknown;
        try {
          raw = JSON.parse(event.data);
        } catch {
          return;
        }
        const parsed = ServerMessage.safeParse(raw);
        if (!parsed.success) return;
        if (parsed.data.type === "presence") setPresence(parsed.data.users);
        else onChangedRef.current();
      };
      ws.onclose = () => {
        if (!closed) retry = setTimeout(connect, RETRY_MS);
      };
      ws.onerror = () => {
        ws.close();
      };
    };
    connect();

    return () => {
      closed = true;
      if (retry !== undefined) clearTimeout(retry);
      socket?.close();
    };
  }, [projectId, docSlug]);

  return presence;
}
