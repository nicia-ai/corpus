import type { Grant } from "../grant";
import type {
  ApiKeyId,
  CorpusSlug,
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
  corpusSlug: CorpusSlug;
  apiKeyId?: ApiKeyId;
  // Present exactly when the credential is an API key: what it may do to its
  // corpus. An OAuth Connection carries no grant (MCP's only write is a proposal).
  apiKeyGrant?: Grant;
}>;
