import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  deleteApiKey,
  generateApiKeyToken,
  insertApiKey,
  listApiKeys,
} from "@/control/api-keys";
import {
  findCanonicalConnectionByCollection,
  listProjectConnections,
} from "@/control/connections";
import { connectControlDb } from "@/control/db";
import { entitlementsOf } from "@/control/entitlements";
import { UnauthorizedError, ValidationError } from "@/errors";
import { asApiKeyId, asCollectionSlug } from "@/ids";
import { authMiddleware, projectMiddleware } from "@/lib/middleware";
import { authedUserId, requireProjectOwner } from "@/lib/server/shared";
import { assertServerContext as srv } from "@/lib/server-context";

// Minting a key binds a new credential to a Connection — per the
// "create/rename/delete/bind" rule in `src/control/connections.ts`,
// owner-only. The project-scoped Connection lookup is the cross-tenant
// guard (same shape as renameConnection/deleteConnection): pulling
// from `listProjectConnections(ref.projectId)` means a stray
// connectionId from another project fails the `.find` with the same
// "unknown connection" shape it would for a typo'd id (no oracle).
const API_KEY_MINT_MSG = "Only an organization owner can mint API keys";

// List-row metadata. The secret is NEVER here — only its short display
// prefix; the plaintext exists once, in ApiKeyCreated.
export type ApiKeyMeta = Readonly<{
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
}>;
export type ApiKeyCreated = Readonly<{
  id: string;
  name: string;
  token: string;
}>;

// `connectionId` lets the form mint a new key without re-resolving the
// Collection; `keys` is the user's keys against that Connection only.
export type ConnectionKeysView = Readonly<{
  connectionId: string;
  keys: ApiKeyMeta[];
}>;

export const listConnectionApiKeys = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .validator(z.object({ collectionSlug: z.string().trim().min(1) }))
  .handler(
    async ({ data, context }): Promise<ConnectionKeysView | undefined> => {
      const c = srv(context);
      const ref = c.project;
      if (ref === undefined) throw new UnauthorizedError("No project");
      const db = connectControlDb(c.env.DB);
      const connectionId = await findCanonicalConnectionByCollection(
        db,
        ref.projectId,
        asCollectionSlug(data.collectionSlug),
      );
      if (connectionId === undefined) return undefined;
      const rows = await listApiKeys(db, authedUserId(c), connectionId);
      return {
        connectionId,
        keys: rows.map((r) => ({
          id: r.id,
          name: r.name,
          tokenPrefix: r.tokenPrefix,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },
  );

export const createApiKey = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(
    z.object({
      name: z.string().trim().min(1).max(100),
      connectionId: z.string().min(1),
    }),
  )
  .handler(async ({ data, context }): Promise<ApiKeyCreated> => {
    const c = srv(context);
    const ref = requireProjectOwner(c.project, API_KEY_MINT_MSG);
    const db = connectControlDb(c.env.DB);
    const target = (await listProjectConnections(db, ref.projectId)).find(
      (cn) => cn.connectionId === data.connectionId,
    );
    if (target === undefined) {
      throw new ValidationError("unknown connection");
    }
    await entitlementsOf(c).assertWithinQuota({
      action: "api_key_mint",
      userId: ref.userId,
      organizationId: ref.organizationId,
      projectId: ref.projectId,
      amount: 1,
    });
    const token = generateApiKeyToken();
    const id = await insertApiKey(db, {
      userId: authedUserId(c),
      organizationId: ref.organizationId,
      connectionId: target.connectionId,
      name: data.name,
      token,
    });
    return { id, name: data.name, token };
  });

export const revokeApiKey = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const c = srv(context);
    await deleteApiKey(
      connectControlDb(c.env.DB),
      asApiKeyId(data.id),
      authedUserId(c),
    );
    return { ok: true };
  });
