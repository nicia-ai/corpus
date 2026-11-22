import { MAX_ASSET_BYTES } from "./asset-kinds.js";
import type { RemoteFile } from "./files-rest.js";
import { type Grant, grantAllows } from "./grant.js";
import type {
  AppliedChange,
  PushConfig,
  PushConflict,
  PushFailure,
  PushSkip,
} from "./push-all.js";
import {
  type FileWriteOutcome,
  moveFile,
  putFile,
  removeFile,
} from "./rest-write.js";
import {
  sha256HexOfBytes,
  type SyncState,
  type TrackedAsset,
  trackedAssets,
} from "./sync-state.js";

// The images and attachments half of `push --all`. A binary cannot be merged
// and has no proposal path, so it is applied or it is not:
//
//   edit    — new files are uploaded, changed ones replaced (`If-Match` the
//             sha-256 last synced), deleted ones removed, renamed ones moved
//   suggest — every one of these is reported as needing edit access
//
// A mismatch is a conflict: the file is left alone, reported, and the run
// continues, exactly like a markdown file whose upstream moved. The plan holds
// hashes only; a file's bytes are read again just before they are sent, one
// at a time.

export type AssetAction = Readonly<
  | { kind: "file-upload"; path: string; sha256: string }
  | {
      kind: "file-replace";
      path: string;
      slug: string;
      baseSha256: string;
      sha256: string;
    }
  | { kind: "file-remove"; path: string; slug: string; baseSha256: string }
  | {
      kind: "file-move";
      from: string;
      path: string;
      slug: string;
      sha256: string;
      size: number;
    }
>;

export type AssetPlan = Readonly<{
  actions: readonly AssetAction[];
  skipped: readonly PushSkip[];
  conflicts: readonly PushConflict[];
  unchanged: number;
  // Tracked entries whose state just catches up with upstream: the bytes
  // already match (someone else pushed the same file, or the state predates a
  // CLI that carries images).
  caughtUp: readonly TrackedAsset[];
}>;

export type AssetPlanInput = Readonly<{
  cfg: PushConfig;
  grant: Grant;
  state: SyncState;
  remote: readonly RemoteFile[];
  // Untracked candidate paths in the checkout, already filtered to the ones
  // `isAssetPath` allows.
  newPaths: readonly string[];
  at: (path: string) => string;
}>;

export async function planAssetPush(input: AssetPlanInput): Promise<AssetPlan> {
  const { cfg, grant, state, remote, newPaths, at } = input;
  const canEdit = grantAllows(grant, "edit");
  const remoteBySlug = new Map(remote.map((r) => [r.slug, r] as const));
  const remoteByPath = new Map(remote.map((r) => [r.path, r] as const));
  const localSha = async (path: string): Promise<string | undefined> => {
    const bytes = await cfg.files.readBytes(at(path));
    return bytes === undefined ? undefined : sha256HexOfBytes(bytes);
  };

  const actions: AssetAction[] = [];
  const skipped: PushSkip[] = [];
  const conflicts: PushConflict[] = [];
  const caughtUp: TrackedAsset[] = [];
  const deleted: TrackedAsset[] = [];
  let unchanged = 0;

  const conflict = (
    entry: TrackedAsset,
    reason: PushConflict["reason"],
  ): void => {
    conflicts.push({ path: entry.path, slug: entry.slug, reason });
  };

  for (const entry of trackedAssets(state)) {
    const local = await localSha(entry.path);
    const upstream = remoteBySlug.get(entry.slug);
    const upstreamMoved =
      upstream !== undefined &&
      (upstream.sha256 !== entry.sha256 || upstream.path !== entry.path);
    if (local === undefined) {
      if (upstream === undefined) continue;
      if (upstreamMoved) conflict(entry, "changed-upstream");
      else if (canEdit) deleted.push(entry);
      else skipped.push({ path: entry.path, reason: "removal-needs-edit" });
      continue;
    }
    if (local === entry.sha256) {
      unchanged += 1;
      continue;
    }
    if (upstream === undefined) {
      conflict(entry, "deleted-upstream");
      continue;
    }
    if (upstreamMoved) {
      if (upstream.path === entry.path && upstream.sha256 === local) {
        caughtUp.push({ ...entry, sha256: local, size: upstream.size });
      } else {
        conflict(entry, "changed-upstream");
      }
      continue;
    }
    if (canEdit) {
      actions.push({
        kind: "file-replace",
        path: entry.path,
        slug: entry.slug,
        baseSha256: entry.sha256,
        sha256: local,
      });
    } else {
      skipped.push({ path: entry.path, reason: "binary-needs-edit" });
    }
  }

  for (const path of [...newPaths].sort()) {
    const local = await localSha(path);
    if (local === undefined) continue;
    const paired = canEdit
      ? deleted.findIndex((entry) => entry.sha256 === local)
      : -1;
    const renamedFrom = deleted[paired];
    if (renamedFrom !== undefined) {
      deleted.splice(paired, 1);
      actions.push({
        kind: "file-move",
        from: renamedFrom.path,
        path,
        slug: renamedFrom.slug,
        sha256: local,
        size: renamedFrom.size,
      });
      continue;
    }
    const occupant = remoteByPath.get(path);
    if (occupant?.sha256 === local) {
      caughtUp.push({
        path,
        slug: occupant.slug,
        sha256: local,
        size: occupant.size,
      });
      continue;
    }
    if (occupant !== undefined) {
      conflicts.push({ path, slug: occupant.slug, reason: "path-taken" });
      continue;
    }
    if (canEdit) actions.push({ kind: "file-upload", path, sha256: local });
    else skipped.push({ path, reason: "binary-needs-edit" });
  }

  for (const entry of deleted) {
    actions.push({
      kind: "file-remove",
      path: entry.path,
      slug: entry.slug,
      baseSha256: entry.sha256,
    });
  }
  return { actions, skipped, conflicts, unchanged, caughtUp };
}

export type AssetSettled = Readonly<{
  applied?: AppliedChange;
  conflict?: PushConflict;
  failed?: PushFailure;
}>;

const failed = (path: string, message: string): AssetSettled => ({
  failed: { path, message },
});

// Send one planned action and say what the server decided, updating `assets`
// (the state's view of what is synced) only for what it accepted.
export async function performAsset(
  cfg: PushConfig,
  action: AssetAction,
  assets: Map<string, TrackedAsset>,
  at: (path: string) => string,
): Promise<AssetSettled> {
  switch (action.kind) {
    case "file-upload":
    case "file-replace": {
      const bytes = await cfg.files.readBytes(at(action.path));
      if (bytes === undefined) return failed(action.path, "the file is gone");
      if (bytes.byteLength > MAX_ASSET_BYTES) {
        return failed(action.path, "the file is larger than 10 MiB");
      }
      if ((await sha256HexOfBytes(bytes)) !== action.sha256) {
        return failed(action.path, "the file changed while pushing; retry");
      }
      const replacing = action.kind === "file-replace";
      const outcome = await putFile(cfg, {
        path: action.path,
        bytes,
        baseSha256: replacing ? action.baseSha256 : undefined,
      });
      if (outcome.kind === "stored") {
        assets.set(action.path, {
          path: action.path,
          slug: outcome.slug,
          sha256: outcome.sha256,
          size: bytes.byteLength,
        });
        return {
          applied: {
            path: action.path,
            action: replacing ? "updated" : "created",
          },
        };
      }
      return refusal(action.path, replacing ? action.slug : undefined, outcome);
    }
    case "file-remove": {
      const outcome = await removeFile(cfg, {
        slug: action.slug,
        baseSha256: action.baseSha256,
      });
      if (outcome.kind === "removed" || outcome.kind === "gone") {
        assets.delete(action.path);
        return { applied: { path: action.path, action: "archived" } };
      }
      return refusal(action.path, action.slug, outcome);
    }
    case "file-move": {
      const outcome = await moveFile(cfg, {
        slug: action.slug,
        path: action.path,
      });
      if (outcome.kind === "moved") {
        assets.delete(action.from);
        assets.set(action.path, {
          path: action.path,
          slug: action.slug,
          sha256: action.sha256,
          size: action.size,
        });
        return {
          applied: { path: action.path, action: "moved", from: action.from },
        };
      }
      return refusal(action.from, action.slug, outcome);
    }
  }
}

function refusal(
  path: string,
  slug: string | undefined,
  outcome: FileWriteOutcome,
): AssetSettled {
  switch (outcome.kind) {
    case "conflict":
      return {
        conflict: {
          path,
          slug,
          reason:
            outcome.currentSha256 === undefined && slug !== undefined
              ? "deleted-upstream"
              : "changed-upstream",
        },
      };
    case "gone":
      return { conflict: { path, slug, reason: "deleted-upstream" } };
    case "path-taken":
      return { conflict: { path, slug, reason: "path-taken" } };
    case "refused":
      return failed(path, outcome.message);
    case "unsupported":
      return failed(
        path,
        "this Corpus server does not store images or attachments; upgrade it",
      );
    default:
      return failed(path, `unexpected response (${outcome.kind})`);
  }
}

export function describeAsset(action: AssetAction): string {
  switch (action.kind) {
    case "file-upload":
      return `upload  ${action.path}`;
    case "file-replace":
      return `replace  ${action.path}  [${action.slug}]`;
    case "file-remove":
      return `delete  ${action.path}  [${action.slug}]`;
    case "file-move":
      return `move  ${action.from} -> ${action.path}  [${action.slug}]`;
  }
}
