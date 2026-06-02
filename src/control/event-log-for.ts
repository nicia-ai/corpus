import type { EventLogStore } from "../event-log-store";
import type { ProjectId } from "../ids";

// The single Project → EventLogStore mapping. This is the multi-tenant
// boundary for the instrumentation event stream; every event append /
// iterate must go through it (never re-inline
// `env.EVENT_LOG_STORE.get(...)`). Sibling to `storeFor` in
// store-for.ts — same `idFromName(projectId)` discipline so a Project's
// canonical data DO and its event log DO are addressable by the same
// branded id.
//
// Two DOs per Project (data + event log) because the event stream is a
// shipped auditability product feature, must be durable, and would
// otherwise compete with documents/collections/blobs for the
// ProjectStore DO's SQLite budget. The dedicated DO removes that
// competition.
export function eventLogFor(
  env: Env,
  projectId: ProjectId,
): DurableObjectStub<EventLogStore> {
  return env.EVENT_LOG_STORE.get(env.EVENT_LOG_STORE.idFromName(projectId));
}
