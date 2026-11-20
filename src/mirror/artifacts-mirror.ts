import { parseState } from "../../cli/sync-state";
import {
  type Bytes,
  commitObject,
  type GitObject,
  type TreeEntry,
} from "../store/domain/git/objects";
import { buildPack } from "../store/domain/git/pack";
import { editTree, type TreeReader } from "../store/domain/git/tree-edit";
import {
  parseReportStatus,
  receivePackRequest,
  ZERO_SHA,
} from "../store/domain/git/wire";
import {
  MAX_PUSH_BYTES,
  MAX_PUSH_OBJECTS,
  MIRROR_BRANCH,
  MIRROR_REF,
  PUSH_TOKEN_TTL_SECONDS,
  STATE_FILE,
} from "../store/domain/git-mirror";

import {
  MirrorPushRejectedError,
  MirrorServiceError,
  MirrorTooLargeError,
} from "./errors";
import type {
  CloneAccess,
  CommitOutcome,
  CommitRequest,
  GitMirror,
  MirrorHead,
  RepoPresence,
} from "./port";

// The Cloudflare Artifacts adapter for the mirror port. The binding reads
// (`log`, `readTree`, `readFile`) and manages repositories and tokens but has
// no write method, so a commit is built here — blob, tree and commit objects
// packed into one pack — and pushed over Git smart HTTP (receive-pack) with a
// short-lived write token. Reading only the trees along the changed paths
// keeps an incremental commit proportional to the change.

const RECEIVE_PACK_PATH = "/git-receive-pack";
const RECEIVE_PACK_REQUEST_TYPE = "application/x-git-receive-pack-request";
const RECEIVE_PACK_RESULT_TYPE = "application/x-git-receive-pack-result";
// Artifacts routes Git traffic by client; present as git does.
const GIT_USER_AGENT = "git/2.45.0";
const BYTES_PER_MIB = 1024 * 1024;

function isArtifactsError(
  error: unknown,
  code: ArtifactsErrorCode,
): error is ArtifactsError {
  return (
    error instanceof Error &&
    error.name === "ArtifactsError" &&
    "code" in error &&
    error.code === code
  );
}

function serviceError(action: string, cause: unknown): MirrorServiceError {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new MirrorServiceError(`Artifacts ${action} failed: ${reason}`, {
    cause,
  });
}

export function artifactsMirror(
  artifacts: Artifacts,
  fetcher: typeof fetch = fetch,
): GitMirror {
  async function open(repo: string): Promise<ArtifactsRepo | undefined> {
    try {
      return await artifacts.get(repo);
    } catch (error) {
      if (isArtifactsError(error, "NOT_FOUND")) return undefined;
      throw serviceError("get", error);
    }
  }

  async function required(repo: string): Promise<ArtifactsRepo> {
    return (
      (await open(repo)) ??
      Promise.reject(
        new MirrorServiceError(`repository ${repo} does not exist`),
      )
    );
  }

  async function readState(
    handle: ArtifactsRepo,
    commit: string,
  ): Promise<MirrorHead["state"]> {
    const file = await handle.readFile({ ref: commit, path: STATE_FILE });
    if (file === null) return undefined;
    try {
      return parseState(await file.text(), STATE_FILE);
    } catch {
      return undefined;
    }
  }

  async function headOf(
    handle: ArtifactsRepo,
  ): Promise<MirrorHead | undefined> {
    const [latest] = await handle.log({ ref: MIRROR_BRANCH, limit: 1 });
    if (latest === undefined) return undefined;
    return {
      commit: latest.hash,
      treeHash: latest.treeHash,
      parents: latest.parents,
      state: await readState(handle, latest.hash),
    };
  }

  const treeReader =
    (handle: ArtifactsRepo): TreeReader =>
    async (sha) => {
      const entries = await handle.readTree(sha);
      return entries === null
        ? undefined
        : entries.map((e): TreeEntry => ({
            mode: e.mode,
            name: e.name,
            sha: e.hash,
          }));
    };

  async function inspect(repo: string): Promise<RepoPresence> {
    const handle = await open(repo);
    if (handle === undefined) return { kind: "missing" };
    using _handle = handle;
    const head = await headOf(handle).catch((error: unknown) => {
      throw serviceError("read", error);
    });
    return head === undefined ? { kind: "empty" } : { kind: "head", head };
  }

  async function create(repo: string): Promise<void> {
    let initialToken: string;
    try {
      initialToken = (
        await artifacts.create(repo, { setDefaultBranch: MIRROR_BRANCH })
      ).token;
    } catch (error) {
      if (isArtifactsError(error, "ALREADY_EXISTS")) return;
      throw serviceError("create", error);
    }
    // Creating a repository mints a write token we never use (pushes mint
    // their own, short-lived). Do not leave a day-long write credential
    // lying around.
    try {
      using handle = await artifacts.get(repo);
      await handle.revokeToken(initialToken);
    } catch (error) {
      console.warn("[mirror] could not revoke the initial token", error);
    }
  }

  async function discard(repo: string): Promise<void> {
    try {
      await artifacts.delete(repo);
    } catch (error) {
      if (isArtifactsError(error, "NOT_FOUND")) return;
      throw serviceError("delete", error);
    }
  }

  async function cloneAccess(
    repo: string,
    ttlSeconds: number,
  ): Promise<CloneAccess> {
    const handle = await required(repo);
    using _handle = handle;
    try {
      const [info, token] = await Promise.all([
        handle.info(),
        handle.createToken("read", ttlSeconds),
      ]);
      return {
        remote: info.remote,
        token: token.plaintext,
        expiresAt: token.expiresAt,
      };
    } catch (error) {
      throw serviceError("clone credential", error);
    }
  }

  async function packFor(
    handle: ArtifactsRepo,
    request: CommitRequest,
  ): Promise<Readonly<{ pack: Bytes; commit: GitObject; count: number }>> {
    const edited = await editTree(
      treeReader(handle),
      request.base?.treeHash,
      request.edit,
    );
    if (edited.root === undefined) {
      throw new MirrorServiceError("the mirror's tree would be empty");
    }
    const commit = await commitObject({
      tree: edited.root,
      parents: request.base === undefined ? [] : [request.base.commit],
      author: request.author,
      committer: request.committer,
      message: request.message,
    });
    const objects = [...edited.objects, commit];
    const bytes = objects.reduce((sum, o) => sum + o.data.length, 0);
    if (objects.length > MAX_PUSH_OBJECTS || bytes > MAX_PUSH_BYTES) {
      throw new MirrorTooLargeError(
        `This corpus is too large to mirror in one push (${String(objects.length)} objects, ${String(Math.ceil(bytes / BYTES_PER_MIB))} MiB).`,
      );
    }
    return { pack: await buildPack(objects), commit, count: objects.length };
  }

  async function push(
    handle: ArtifactsRepo,
    request: CommitRequest,
    built: Awaited<ReturnType<typeof packFor>>,
  ): Promise<Uint8Array> {
    const { remote } = await handle.info();
    const token = await handle.createToken("write", PUSH_TOKEN_TTL_SECONDS);
    try {
      const body = receivePackRequest(
        {
          ref: MIRROR_REF,
          oldSha: request.base?.commit ?? ZERO_SHA,
          newSha: built.commit.sha,
        },
        built.pack,
      );
      const response = await fetcher(`${remote}${RECEIVE_PACK_PATH}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.plaintext}`,
          "content-type": RECEIVE_PACK_REQUEST_TYPE,
          accept: RECEIVE_PACK_RESULT_TYPE,
          "user-agent": GIT_USER_AGENT,
        },
        body,
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!response.ok) {
        throw new MirrorServiceError(
          `Git push answered HTTP ${String(response.status)}`,
        );
      }
      return bytes;
    } finally {
      await handle.revokeToken(token.id).catch((error: unknown) => {
        console.warn("[mirror] could not revoke the push token", error);
      });
    }
  }

  async function commit(request: CommitRequest): Promise<CommitOutcome> {
    const handle = await required(request.repo);
    using _handle = handle;
    const built = await packFor(handle, request);
    const reply = parseReportStatus(await push(handle, request, built));
    if (reply.unpack !== "ok") {
      throw new MirrorPushRejectedError(`unpack ${reply.unpack}`);
    }
    const verdict = reply.refs.get(MIRROR_REF);
    if (verdict?.ok === true) {
      return {
        kind: "pushed",
        commit: built.commit.sha,
        objects: built.count,
        bytes: built.pack.length,
      };
    }
    // The service answers HTTP 200 for a refused ref update, with a reason
    // string. Whether it was a lost race is decided from the branch itself,
    // not from that text.
    const now = (await headOf(handle))?.commit;
    if (now !== request.base?.commit) return { kind: "stale" };
    throw new MirrorPushRejectedError(
      verdict === undefined ? "no verdict for the branch" : verdict.reason,
    );
  }

  return { inspect, create, commit, discard, cloneAccess };
}
