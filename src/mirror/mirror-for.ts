import { artifactsMirror } from "./artifacts-mirror";
import type { GitMirror } from "./port";

// The single place a deployment's Git mirror is resolved: the Artifacts
// binding when it is configured, otherwise nothing — the mirror is optional,
// and absent means off everywhere (no records are kept, the clone endpoint
// answers "not enabled", the UI hides the section).

// Test seam (module-level, like `setGraphStatementSinkForTest`): the
// ProjectStore runs in the same isolate as the tests, so a test can wrap the
// real port to inject a failure or a racing push. Never set in production.
let override: GitMirror | undefined;

export function setGitMirrorForTest(mirror: GitMirror | undefined): void {
  override = mirror;
}

export function mirrorFor(env: Env): GitMirror | undefined {
  if (override !== undefined) return override;
  return env.ARTIFACTS === undefined
    ? undefined
    : artifactsMirror(env.ARTIFACTS);
}
