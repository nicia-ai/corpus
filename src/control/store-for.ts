import type { ProjectId } from "../ids";
import type { ProjectStore } from "../project-store";

// The single Project → ProjectStore mapping. This is the multi-tenant
// boundary; every data-plane access must go through it. A Collection
// is an entity inside the DO, never a partition key — the whole graph
// lives in one DO per Project. Extracted to its own module so both
// `tenancy.ts` and `org-lifecycle.ts` can use it without an import
// cycle.
export function storeFor(
  env: Env,
  projectId: ProjectId,
): DurableObjectStub<ProjectStore> {
  return env.PROJECT_STORE.get(env.PROJECT_STORE.idFromName(projectId));
}
