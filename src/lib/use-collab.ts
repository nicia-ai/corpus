import { useEffect, useEffectEvent, useState } from "react";

import type { ProjectId } from "@/ids";
import {
  ServerMessage,
  type PresenceUser,
  type RealtimeChange,
} from "@/project-store/presence";

export type { PresenceUser, RealtimeChange } from "@/project-store/presence";

const RETRY_MS = 2000;

// Subscribe to the project's real-time channel for the open document: returns
// the live presence list and invokes `onChanged` whenever the project signals
// a write so the caller can re-fetch. This is the ONE sanctioned useEffect
// subscription — it owns a socket, not loader data.
export function useCollab(
  projectId: ProjectId,
  docSlug: string,
  onChanged: (change: RealtimeChange | undefined) => void,
): readonly PresenceUser[] {
  const [presence, setPresence] = useState<readonly PresenceUser[]>([]);
  // Read the latest caller state without reconnecting the socket. An Effect
  // Event updates with the commit, avoiding the passive-effect lag of a
  // hand-rolled callback ref when a socket message races a render.
  const onChangedEvent = useEffectEvent(onChanged);

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
        else onChangedEvent(parsed.data.change);
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
