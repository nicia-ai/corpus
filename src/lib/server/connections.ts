import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { resolveConnection as resolveConnectionRef } from "@/control/connection-resolution";
import {
  deleteConnection as deleteConnectionRow,
  listAdministeredConnections,
  listProjectConnections,
  renameConnection as renameConnectionRow,
  upsertCanonicalConnection,
  type ProjectConnectionRow,
} from "@/control/connections";
import { connectControlDb } from "@/control/db";
import {
  handshakeId,
  putSelection,
  readPendingConnect,
  writePendingConnect,
} from "@/control/oauth-selection";
import { ForbiddenError, UnauthorizedError, ValidationError } from "@/errors";
import {
  asConnectionId,
  asCollectionSlug,
  type ConnectionId,
  type CollectionSlug,
  type OrganizationId,
  type ProjectId,
} from "@/ids";
import { authMiddleware, projectMiddleware } from "@/lib/middleware";
import { authedUserId, requireProjectOwner } from "@/lib/server/shared";
import { assertServerContext as srv } from "@/lib/server-context";

// Connection administration (create/rename/delete/bind a new credential)
// is owner-only — Connections are an org/project asset, not personal.
// Reads (existing credentials, including via this Connection) stay
// role-agnostic (any member); the `resolveConnection` per-request join
// in `tenancy.ts` enforces that side.
const CONNECTION_ADMIN_MSG =
  "Only an organization owner can manage Connections";

// Primary action behind "Connect this collection" on the Collection
// page. Reuse-or-create the canonical Connection for (projectId,
// collectionSlug) and write the userId-keyed pending-connect intent
// (`/connect/select` pre-selects from it; the intent is a *picker
// default*, never the binding mechanism — binding still requires the
// explicit pick + the handshake-keyed selection row). One D1
// write (or a no-op reuse), so the Connection is never a precondition
// the user satisfies before connecting an agent.
export type ConnectCollectionResult = Readonly<{
  connectionId: ConnectionId;
  collectionSlug: CollectionSlug;
}>;

export const connectThisCollection = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(z.object({ collectionSlug: z.string().trim().min(1) }))
  .handler(async ({ data, context }): Promise<ConnectCollectionResult> => {
    const c = srv(context);
    const ref = requireProjectOwner(c.project, CONNECTION_ADMIN_MSG);
    const db = connectControlDb(c.env.DB);
    const collectionSlug = asCollectionSlug(data.collectionSlug);
    const connectionId = await upsertCanonicalConnection(db, {
      organizationId: ref.organizationId,
      projectId: ref.projectId,
      collectionSlug,
    });
    await writePendingConnect(db, ref.userId, connectionId);
    return { connectionId, collectionSlug };
  });

// The `projectId` is taken from the request-scoped ProjectRef (the URL
// path), NEVER from the body — the client-supplied `connectionId` is
// scoped against the project the caller proved ownership of. An owner
// in project A who passes a connectionId from project B silently no-ops
// (the scoped WHERE matches 0 rows). See the comment on
// `renameConnection` in `src/control/connections.ts`.
export const renameConnection = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(
    z.object({
      connectionId: z.string().min(1),
      name: z.string().trim().min(1).max(100),
    }),
  )
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const c = srv(context);
    const ref = requireProjectOwner(c.project, CONNECTION_ADMIN_MSG);
    await renameConnectionRow(connectControlDb(c.env.DB), {
      connectionId: asConnectionId(data.connectionId),
      projectId: ref.projectId,
      name: data.name,
    });
    return { ok: true };
  });

export const deleteConnection = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(z.object({ connectionId: z.string().min(1) }))
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const c = srv(context);
    const ref = requireProjectOwner(c.project, CONNECTION_ADMIN_MSG);
    await deleteConnectionRow(connectControlDb(c.env.DB), {
      connectionId: asConnectionId(data.connectionId),
      projectId: ref.projectId,
    });
    return { ok: true };
  });

export const listProjectConnectionsFn = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .handler(async ({ context }): Promise<readonly ProjectConnectionRow[]> => {
    const c = srv(context);
    const ref = c.project;
    if (ref === undefined) throw new UnauthorizedError("No project");
    return listProjectConnections(connectControlDb(c.env.DB), ref.projectId);
  });

// — /connect/select wiring. The post-login picker is project-agnostic:
//   a Connection self-describes its Project, so the chosen Connection
//   is what supplies projectId. Owner-administered only (only owners
//   can bind a new agent to a Connection).

export type PickerRow = Readonly<{
  connectionId: ConnectionId;
  organizationId: OrganizationId;
  projectId: ProjectId;
  projectName: string;
  collectionSlug: CollectionSlug;
  name: string;
  isDefaultForCollection: boolean;
}>;

export const listMyAdministeredConnections = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<PickerRow[]> => {
    const c = srv(context);
    const rows = await listAdministeredConnections(
      connectControlDb(c.env.DB),
      authedUserId(c),
    );
    return rows.map((r) => ({
      connectionId: r.connectionId,
      organizationId: r.organizationId,
      projectId: r.projectId,
      projectName: r.projectName,
      collectionSlug: r.collectionSlug,
      name: r.name,
      isDefaultForCollection: r.isDefaultForCollection,
    }));
  });

// Commit the picker selection. `oauthQuery` is the signed authorization
// query the picker page was loaded with (`window.location.search`); we
// trust it only as a *lookup key*, never as authority — a forged query
// simply writes a row under a handshake id that no real
// `consentReferenceId` read will match, so the worst case is a claimless
// token (403), never a wrong-Connection bind. Authority comes from the
// two checks here: `resolveConnection` (the signed-in user administers
// this Connection) and the owner-role gate. Returns `ok:false` when the
// query is not an in-flight authorization (no `code_challenge`/`state`)
// so the UI can explain instead of failing silently to a later 403.
export type SelectionResult = Readonly<
  { ok: true } | { ok: false; reason: "no-in-flight-authorization" }
>;

export const commitConnectionSelection = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      connectionId: z.string().min(1),
      oauthQuery: z.string(),
    }),
  )
  .handler(async ({ data, context }): Promise<SelectionResult> => {
    const c = srv(context);
    const db = connectControlDb(c.env.DB);
    const userId = authedUserId(c);
    const ref = await resolveConnectionRef(db, {
      userId,
      connectionId: data.connectionId,
    });
    if (ref === undefined) {
      throw new ValidationError("unknown connection");
    }
    if (ref.role !== "owner") {
      throw new ForbiddenError(
        "Only an organization owner can bind a new agent to this Connection",
      );
    }
    if (handshakeId(data.oauthQuery) === undefined) {
      return { ok: false, reason: "no-in-flight-authorization" };
    }
    await putSelection(db, data.oauthQuery, userId, data.connectionId);
    return { ok: true };
  });

// Look up the userId-keyed pending-connect intent (the Collection-page
// "Connect this collection" hint). `/connect/select` calls this to
// pre-select; the read is non-binding — binding still requires the
// explicit pick + the handshake-keyed selection row.
export const readPendingConnectFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(
    async ({
      context,
    }): Promise<{ connectionId: ConnectionId | undefined }> => {
      const c = srv(context);
      const id = await readPendingConnect(
        connectControlDb(c.env.DB),
        authedUserId(c),
      );
      return {
        connectionId: id === undefined ? undefined : asConnectionId(id),
      };
    },
  );
