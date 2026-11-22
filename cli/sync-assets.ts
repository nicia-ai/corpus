import type { SyncConfig } from "./core.js";
import { CliError } from "./errors.js";
import { downloadFile, type RemoteFile } from "./files-rest.js";
import {
  collisionKey,
  sha256HexOfBytes,
  type SyncState,
  type TrackedAsset,
  trackedAssets,
  unsafePathProblem,
} from "./sync-state.js";
import type { ConflictReason, SyncConflict } from "./sync.js";

// The images and attachments half of `pull --all`: the same rules as the
// markdown half, applied to bytes. A tracked file is skipped when its hash
// already matches, is never overwritten over a local edit without
// `overwrite`, and every download is verified against the hash Corpus listed
// before it touches the disk. Planning (listing, local reads) is finished
// before the first download; the downloads then run one at a time, so a large
// corpus of images is never held in memory at once.

type Stay = Readonly<{
  kind: "stay";
  entry: TrackedAsset;
  editedLocally: boolean;
}>;
type Write = Readonly<{
  kind: "write";
  remote: RemoteFile;
  base: TrackedAsset | undefined;
  baseWasPresent: boolean;
  needsWrite: boolean;
  occupiedByTracked: boolean;
}>;
type Remove = Readonly<{ kind: "remove"; entry: TrackedAsset }>;
type Blocked = Readonly<{
  kind: "blocked";
  entry: TrackedAsset | undefined;
  conflict: SyncConflict;
}>;
export type AssetDecision = Stay | Write | Remove | Blocked;

export type AssetChange = Readonly<{ path: string; from?: string }>;

export type AssetReport = Readonly<{
  added: readonly AssetChange[];
  updated: readonly AssetChange[];
  removed: readonly string[];
  unchanged: readonly string[];
  keptLocal: readonly string[];
  conflicts: readonly SyncConflict[];
}>;

export type AssetSyncInput = Readonly<{
  cfg: SyncConfig;
  state: SyncState;
  remote: readonly RemoteFile[];
  overwrite: boolean;
  // A checkout-relative path as the host addresses it.
  at: (path: string) => string;
}>;

// Reject the whole run, before any write, when a server-supplied path is
// unsafe to materialize or would share a file with another path (a document's
// included) on a case-insensitive filesystem.
export function validatedAssets(
  remote: readonly RemoteFile[],
  documentPaths: readonly string[],
): readonly RemoteFile[] {
  const seen = new Map(documentPaths.map((p) => [collisionKey(p), p] as const));
  for (const file of remote) {
    const problem = unsafePathProblem(file.path);
    if (problem !== undefined) {
      throw new CliError(
        "unsafe-path",
        `refusing file "${file.slug}" at path "${file.path}": ${problem}.`,
      );
    }
    const key = collisionKey(file.path);
    const other = seen.get(key);
    if (other !== undefined) {
      throw new CliError(
        "unsafe-path",
        `"${other}" and "${file.path}" differ only by case or Unicode form and would share one file on a case-insensitive filesystem; rename one in Corpus.`,
      );
    }
    seen.set(key, file.path);
  }
  return remote;
}

export async function planAssets(
  input: AssetSyncInput,
): Promise<readonly AssetDecision[]> {
  const { cfg, state, remote, overwrite, at } = input;
  const tracked = trackedAssets(state);
  const trackedBySlug = new Map(tracked.map((a) => [a.slug, a] as const));
  const trackedByPath = new Map(tracked.map((a) => [a.path, a] as const));
  const remoteSlugs = new Set(remote.map((r) => r.slug));

  const shaCache = new Map<string, string | undefined>();
  const localSha = async (path: string): Promise<string | undefined> => {
    if (shaCache.has(path)) return shaCache.get(path);
    const bytes = await cfg.files.readBytes(at(path));
    const sha = bytes === undefined ? undefined : await sha256HexOfBytes(bytes);
    shaCache.set(path, sha);
    return sha;
  };

  const decisions: AssetDecision[] = [];
  for (const r of remote) {
    const base = trackedBySlug.get(r.slug);
    const upstreamUnchanged = base?.path === r.path && base.sha256 === r.sha256;
    const current = upstreamUnchanged ? await localSha(base.path) : undefined;
    if (upstreamUnchanged && current !== undefined) {
      const editedLocally = current !== base.sha256;
      if (!editedLocally || !overwrite) {
        decisions.push({ kind: "stay", entry: base, editedLocally });
        continue;
      }
    }
    decisions.push(
      await decideWrite(r, base, localSha, trackedByPath, overwrite),
    );
  }

  for (const entry of tracked) {
    if (remoteSlugs.has(entry.slug)) continue;
    const current = await localSha(entry.path);
    const edited = current !== undefined && current !== entry.sha256;
    decisions.push(
      edited && !overwrite
        ? {
            kind: "blocked",
            entry,
            conflict: {
              slug: entry.slug,
              path: entry.path,
              reason: "deleted-upstream",
            },
          }
        : { kind: "remove", entry },
    );
  }
  return settlePathContention(decisions);
}

async function decideWrite(
  remote: RemoteFile,
  base: TrackedAsset | undefined,
  localSha: (path: string) => Promise<string | undefined>,
  trackedByPath: ReadonlyMap<string, TrackedAsset>,
  overwrite: boolean,
): Promise<AssetDecision> {
  const target = remote.path;
  const atTarget = await localSha(target);
  const basePath = base?.path;
  const old = basePath === undefined ? undefined : await localSha(basePath);
  const editedLocally =
    base !== undefined && old !== undefined && old !== base.sha256;
  const identicalAtTarget = atTarget === remote.sha256;

  if (
    editedLocally &&
    !overwrite &&
    !(basePath === target && identicalAtTarget)
  ) {
    return blocked(base, remote, basePath ?? target, "edited-locally");
  }
  const occupiedByOther =
    atTarget !== undefined && basePath !== target && !identicalAtTarget;
  const occupantIsTracked = occupiedByOther && trackedByPath.has(target);
  if (occupiedByOther && !occupantIsTracked && !overwrite) {
    return blocked(base, remote, target, "untracked-in-the-way");
  }
  return {
    kind: "write",
    remote,
    base,
    baseWasPresent: old !== undefined,
    needsWrite: !identicalAtTarget,
    occupiedByTracked: occupantIsTracked,
  };
}

function blocked(
  entry: TrackedAsset | undefined,
  remote: RemoteFile,
  path: string,
  reason: ConflictReason,
): Blocked {
  return {
    kind: "blocked",
    entry,
    conflict: { slug: remote.slug, path, reason },
  };
}

const vacatedPath = (d: AssetDecision): string | undefined => {
  if (d.kind === "remove") return d.entry.path;
  if (d.kind === "write" && d.base !== undefined) {
    return d.base.path === d.remote.path ? undefined : d.base.path;
  }
  return undefined;
};

// A write onto a path still held by another tracked file is only safe when
// that file is itself leaving; anything else becomes a conflict, which keeps
// ITS old path occupied. Iterate until no decision changes.
function settlePathContention(
  decisions: readonly AssetDecision[],
): readonly AssetDecision[] {
  let current = decisions;
  for (;;) {
    const vacated = new Set(
      current.map(vacatedPath).filter((p): p is string => p !== undefined),
    );
    const next = current.map((d): AssetDecision => {
      if (d.kind !== "write" || !d.occupiedByTracked) return d;
      if (vacated.has(d.remote.path)) return d;
      return blocked(d.base, d.remote, d.remote.path, "path-taken");
    });
    if (next.every((d, i) => d === current[i])) return next;
    current = next;
  }
}

// Remove what left, then download and write what changed, one file at a time.
// `completed` collects the decisions that took effect, so a failure part-way
// can still record exactly what was written.
export async function applyAssets(
  input: AssetSyncInput,
  decisions: readonly AssetDecision[],
  completed: Set<AssetDecision>,
): Promise<void> {
  const { cfg, at } = input;
  for (const d of decisions) {
    const gone = vacatedPath(d);
    if (
      gone !== undefined &&
      (await cfg.files.readBytes(at(gone))) !== undefined
    ) {
      await cfg.files.remove(at(gone));
    }
  }
  for (const d of decisions) {
    if (d.kind === "write" && d.needsWrite) {
      const bytes = await downloadFile(cfg, d.remote);
      await cfg.files.writeBytes(at(d.remote.path), bytes);
    }
    completed.add(d);
  }
}

// What the state records for the assets, given which decisions took effect.
// A decision that did not run leaves its entry as it was.
export function assetsAfter(
  decisions: readonly AssetDecision[],
  completed: ReadonlySet<AssetDecision>,
): readonly TrackedAsset[] {
  return decisions.flatMap((d): readonly TrackedAsset[] => {
    switch (d.kind) {
      case "stay":
        return [d.entry];
      case "blocked":
        return d.entry === undefined ? [] : [d.entry];
      case "remove":
        return completed.has(d) ? [] : [d.entry];
      case "write":
        if (!completed.has(d)) return d.base === undefined ? [] : [d.base];
        return [
          {
            path: d.remote.path,
            slug: d.remote.slug,
            sha256: d.remote.sha256,
            size: d.remote.size,
          },
        ];
    }
  });
}

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function assetReport(decisions: readonly AssetDecision[]): AssetReport {
  const added: AssetChange[] = [];
  const updated: AssetChange[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];
  const keptLocal: string[] = [];
  const conflicts: SyncConflict[] = [];
  for (const d of decisions) {
    if (d.kind === "stay") {
      (d.editedLocally ? keptLocal : unchanged).push(d.entry.path);
    } else if (d.kind === "remove") {
      removed.push(d.entry.path);
    } else if (d.kind === "blocked") {
      conflicts.push(d.conflict);
    } else {
      const { remote, base } = d;
      const moved = base !== undefined && base.path !== remote.path;
      if (!d.needsWrite && !moved) {
        unchanged.push(remote.path);
      } else {
        const change: AssetChange = moved
          ? { path: remote.path, from: base.path }
          : { path: remote.path };
        (base === undefined || !d.baseWasPresent ? added : updated).push(
          change,
        );
      }
    }
  }
  return {
    added,
    updated,
    removed,
    unchanged,
    keptLocal,
    conflicts: [...conflicts].sort((a, b) => byPath(a.path, b.path)),
  };
}
