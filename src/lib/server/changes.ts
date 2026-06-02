import { createServerFn } from "@tanstack/react-start";

import { connectControlDb } from "@/control/db";
import { resolveUserNames } from "@/control/users";
import { projectMiddleware } from "@/lib/middleware";
import { storeOf } from "@/lib/server/shared";
import { assertServerContext as srv } from "@/lib/server-context";
import { compact } from "@/util";

export type Change = Readonly<{
  id: number;
  eventType: string;
  documentSlug: string | null;
  collectionSlug: string | null;
  changedAt: string;
  changedBy: string;
  changedByName?: string;
  // The full recorded event, pretty-printed server-side (the ledger's
  // own columns + parsed before/after). A plain string so it crosses the
  // server-fn boundary; the client just renders it in the expand panel.
  detail: string;
}>;

// The ledger stores before/after as JSON text. Parse defensively — a
// malformed row degrades to the raw string, never breaks the feed.
function parseBody(json: string | null): unknown {
  if (json === null || json === "") return undefined;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return json;
  }
}

export const getChanges = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .handler(async ({ context }): Promise<Change[]> => {
    const c = srv(context);
    const rows = await storeOf(c).recentChanges(50);
    const names = await resolveUserNames(
      connectControlDb(c.env.DB),
      rows.map((r) => r.changedBy),
    );
    return rows.map((r) => {
      const detail = JSON.stringify(
        compact({
          event: r.eventType,
          document: r.documentSlug ?? undefined,
          collection: r.collectionSlug ?? undefined,
          by: names.get(r.changedBy) ?? r.changedBy,
          at: r.changedAt,
          before: parseBody(r.beforeJson),
          after: parseBody(r.afterJson),
        }),
        null,
        2,
      );
      return compact({
        id: r.id,
        eventType: r.eventType,
        documentSlug: r.documentSlug,
        collectionSlug: r.collectionSlug,
        changedAt: r.changedAt,
        changedBy: r.changedBy,
        changedByName: names.get(r.changedBy),
        detail,
      });
    });
  });
