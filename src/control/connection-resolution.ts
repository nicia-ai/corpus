import { and, eq, inArray } from "drizzle-orm";

import {
  asApiKeyId,
  asCollectionSlug,
  asConnectionId,
  asOrganizationId,
  asProjectId,
  asUserId,
} from "../ids";
import { compact } from "../util";

import {
  ACCESSIBLE_STATUSES,
  asRole,
  isAccessible,
  type ProjectStatus,
} from "./access";
import { hashApiKeyToken } from "./api-keys";
import type { ControlDb } from "./db";
import type { ConnectionRef } from "./refs";
import { apiKey, connection, project } from "./schema/app";
import { member } from "./schema/better-auth";

type ConnRow = Readonly<{
  organizationId: string;
  projectId: string;
  collectionSlug: string;
  connectionId: string;
  userId: string;
  role: string;
  status: ProjectStatus;
  apiKeyId?: string;
}>;

function toConnectionRef(row: ConnRow): ConnectionRef {
  return compact({
    organizationId: asOrganizationId(row.organizationId),
    projectId: asProjectId(row.projectId),
    userId: asUserId(row.userId),
    role: asRole(row.role),
    connectionId: asConnectionId(row.connectionId),
    collectionSlug: asCollectionSlug(row.collectionSlug),
    apiKeyId: row.apiKeyId === undefined ? undefined : asApiKeyId(row.apiKeyId),
  });
}

// Resolve an MCP API-key bearer to its Connection. Uncached: indexed
// joins are cheap, and revocation must be immediate.
export async function resolveApiKey(
  db: ControlDb,
  presentedToken: string,
): Promise<ConnectionRef | undefined> {
  const tokenHash = await hashApiKeyToken(presentedToken);
  const [row] = await db
    .select({
      organizationId: connection.organizationId,
      projectId: connection.projectId,
      collectionSlug: connection.collectionSlug,
      connectionId: connection.id,
      userId: apiKey.userId,
      role: member.role,
      status: project.status,
      apiKeyId: apiKey.id,
    })
    .from(apiKey)
    .innerJoin(connection, eq(connection.id, apiKey.connectionId))
    .innerJoin(
      member,
      and(
        eq(member.organizationId, connection.organizationId),
        eq(member.userId, apiKey.userId),
      ),
    )
    .innerJoin(
      project,
      and(
        eq(project.id, connection.projectId),
        eq(project.organizationId, connection.organizationId),
        inArray(project.status, ACCESSIBLE_STATUSES),
      ),
    )
    .where(eq(apiKey.tokenHash, tokenHash))
    .limit(1);
  if (row === undefined || !isAccessible(row.status)) return undefined;
  return toConnectionRef(row);
}

// Resolve an OAuth grant's Connection claim to its Connection. Uncached
// for the same revocation posture as API keys.
export async function resolveConnection(
  db: ControlDb,
  args: Readonly<{ userId: string; connectionId: string }>,
): Promise<ConnectionRef | undefined> {
  if (args.userId === "" || args.connectionId === "") return undefined;
  const [row] = await db
    .select({
      organizationId: connection.organizationId,
      projectId: connection.projectId,
      collectionSlug: connection.collectionSlug,
      connectionId: connection.id,
      userId: member.userId,
      role: member.role,
      status: project.status,
    })
    .from(connection)
    .innerJoin(
      member,
      and(
        eq(member.organizationId, connection.organizationId),
        eq(member.userId, args.userId),
      ),
    )
    .innerJoin(
      project,
      and(
        eq(project.id, connection.projectId),
        eq(project.organizationId, connection.organizationId),
        inArray(project.status, ACCESSIBLE_STATUSES),
      ),
    )
    .where(eq(connection.id, args.connectionId))
    .limit(1);
  if (row === undefined || !isAccessible(row.status)) return undefined;
  return toConnectionRef(row);
}
