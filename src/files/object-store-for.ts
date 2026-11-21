import { type ObjectStore, r2ObjectStore } from "../store/repos/object-store";

// The single place a deployment's file storage is resolved: the `FILES` R2
// binding when it is configured, otherwise nothing. Files are optional,
// exactly like the Git mirror: absent means off everywhere (the upload
// endpoint answers "not enabled", the editor hides its upload affordances,
// no error anywhere).

// Test seam (module-level, like `setGitMirrorForTest`): the ProjectStore and
// the Worker run in the same isolate as the tests, so a test can wrap the
// real store to inject a failure or record the order of writes. Never set in
// production.
let override: ObjectStore | undefined;

export function setObjectStoreForTest(store: ObjectStore | undefined): void {
  override = store;
}

export function objectStoreFor(env: Env): ObjectStore | undefined {
  if (override !== undefined) return override;
  return env.FILES === undefined ? undefined : r2ObjectStore(env.FILES);
}

export const FILES_NOT_ENABLED_MESSAGE =
  "File uploads are not enabled on this deployment.";
