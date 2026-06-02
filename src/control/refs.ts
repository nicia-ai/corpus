import type {
  ApiKeyId,
  CollectionSlug,
  ConnectionId,
  OrganizationId,
  ProjectId,
  UserId,
} from "../ids";

import type { Role } from "./access";

export type ProjectRef = Readonly<{
  organizationId: OrganizationId;
  projectId: ProjectId;
  userId: UserId;
  role: Role;
}>;

// The MCP boundary's tenant currency. Deliberately NOT a widened
// `ProjectRef`: the web's `ProjectRef` is mandatory-Project and the MCP
// invariant is mandatory-Connection.
export type ConnectionRef = Readonly<{
  organizationId: OrganizationId;
  projectId: ProjectId;
  userId: UserId;
  role: Role;
  connectionId: ConnectionId;
  collectionSlug: CollectionSlug;
  apiKeyId?: ApiKeyId;
}>;
