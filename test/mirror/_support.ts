import { env, runInDurableObject, SELF } from "cloudflare:test";

import type { FetchLike, SyncConfig, TreeFiles } from "../../cli/core";
import { pullAll } from "../../cli/sync";
import {
  apiKeyDisplayPrefix,
  generateApiKeyToken,
  hashApiKeyToken,
} from "../../src/control/api-keys";
import { connectControlDb } from "../../src/control/db";
import { apiKey } from "../../src/control/schema/app";
import { storeFor } from "../../src/control/store-for";
import {
  asDocumentSlug,
  type CorpusSlug,
  type DocumentSlug,
  type ProjectId,
  type UserId,
} from "../../src/ids";
import type { ProjectStore } from "../../src/project-store";
import { sniffFormat } from "../../src/store/domain/file-kinds";
import { mirrorRepoName } from "../../src/store/domain/git-mirror";
import {
  fileObjectKey,
  r2ObjectStore,
} from "../../src/store/repos/object-store";
import { sha256Hex } from "../../src/util";
import { createConnection, createOrg, signUp } from "../_helpers";

// A real project (org, owner, API key bound to one corpus) over the local
// Artifacts simulator: the same shape a customer has, so the mirror is
// exercised end to end — DO write → outbox → push → repository.

export const BASE_URL = "https://example.com";
const CHECKOUT = "checkout";

export type Fixture = Readonly<{
  projectId: ProjectId;
  corpusSlug: CorpusSlug;
  ownerUserId: UserId;
  token: string;
  store: DurableObjectStub<ProjectStore>;
  repoName: string;
}>;

export async function newFixture(): Promise<Fixture> {
  const ownerUserId = await signUp("mirror");
  const ref = await createOrg(ownerUserId, "Org mirror");
  const conn = await createConnection({
    organizationId: ref.organizationId,
    projectId: ref.projectId,
  });
  const store = storeFor(env, ref.projectId);
  await store.createCorpus({
    slug: conn.corpusSlug,
    name: "Handbook",
    changedBy: ownerUserId,
  });
  const token = generateApiKeyToken();
  await connectControlDb(env.DB)
    .insert(apiKey)
    .values({
      userId: ownerUserId,
      organizationId: ref.organizationId,
      connectionId: conn.connectionId,
      name: "mirror",
      tokenHash: await hashApiKeyToken(token),
      tokenPrefix: apiKeyDisplayPrefix(token),
    });
  return {
    projectId: ref.projectId,
    corpusSlug: conn.corpusSlug,
    ownerUserId,
    token,
    store,
    repoName: mirrorRepoName(ref.projectId, conn.corpusSlug),
  };
}

// Write (create or update) a document by corpus-relative path.
export async function put(
  fixture: Fixture,
  path: string,
  markdown: string,
): Promise<DocumentSlug> {
  const result = await fixture.store.importDocumentAtPath({
    corpusSlug: fixture.corpusSlug,
    path,
    markdown,
    changedBy: fixture.ownerUserId,
  });
  if (!result.ok) throw new Error(`fixture: could not write ${path}`);
  return asDocumentSlug(result.slug);
}

export async function slugAt(
  fixture: Fixture,
  path: string,
): Promise<DocumentSlug> {
  const row = (await fixture.store.listDocuments()).find(
    (d) => d.corpusSlug === fixture.corpusSlug && d.path === path,
  );
  if (row === undefined) throw new Error(`fixture: no document at ${path}`);
  return asDocumentSlug(row.slug);
}

export type MirrorSnapshot = Readonly<{
  commits: readonly ArtifactsCommitMetadata[];
  head: ArtifactsCommitMetadata;
  // Every file as text (lossy for binaries) and as the exact bytes.
  files: ReadonlyMap<string, string>;
  bytes: ReadonlyMap<string, Uint8Array>;
}>;

async function walk(
  repo: ArtifactsRepo,
  treeHash: string,
  prefix: string,
  into: Readonly<{
    files: Map<string, string>;
    bytes: Map<string, Uint8Array>;
  }>,
): Promise<void> {
  for (const entry of (await repo.readTree(treeHash)) ?? []) {
    const path = `${prefix}${entry.name}`;
    if (entry.type === "tree") {
      await walk(repo, entry.hash, `${path}/`, into);
    } else {
      const blob = await repo.readBlob(entry.hash);
      const raw =
        blob === null ? undefined : new Uint8Array(await blob.arrayBuffer());
      into.bytes.set(path, raw ?? new Uint8Array());
      into.files.set(
        path,
        raw === undefined ? "<missing>" : new TextDecoder().decode(raw),
      );
    }
  }
}

function artifacts(): Artifacts {
  if (env.ARTIFACTS === undefined) throw new Error("no ARTIFACTS binding");
  return env.ARTIFACTS;
}

// The repository as a client would see it, read through the binding.
export async function readMirror(
  repoName: string,
): Promise<MirrorSnapshot | undefined> {
  const repo = await artifacts()
    .get(repoName)
    .catch(() => undefined);
  if (repo === undefined) return undefined;
  using _repo = repo;
  const commits = await repo.log({ ref: "main", limit: 1000 });
  const [head] = commits;
  if (head === undefined) return undefined;
  const files = new Map<string, string>();
  const bytes = new Map<string, Uint8Array>();
  await walk(repo, head.treeHash, "", { files, bytes });
  return { commits, head, files, bytes };
}

export async function mirrorExists(repoName: string): Promise<boolean> {
  return (await artifacts().list({ limit: 200 })).repos.some(
    (r) => r.name === repoName,
  );
}

type Checkout = Readonly<{
  text: ReadonlyMap<string, string>;
  binary: ReadonlyMap<string, Uint8Array>;
}>;

async function pullCheckout(fixture: Fixture): Promise<Checkout> {
  const text = new Map<string, string>();
  const binary = new Map<string, Uint8Array<ArrayBuffer>>();
  const files: TreeFiles = {
    readText: (path) => Promise.resolve(text.get(path)),
    writeText: (path, data) => {
      text.set(path, data);
      return Promise.resolve();
    },
    readBytes: (path) => Promise.resolve(binary.get(path)),
    writeBytes: (path, data) => {
      binary.set(path, data);
      return Promise.resolve();
    },
    remove: (path) => {
      text.delete(path);
      binary.delete(path);
      return Promise.resolve();
    },
  };
  const fetch: FetchLike = (input, init) => SELF.fetch(input, init);
  const config: SyncConfig = {
    baseUrl: BASE_URL,
    apiKey: fixture.token,
    fetch,
    files,
  };
  await pullAll(config, CHECKOUT);
  const relative = <T>(map: ReadonlyMap<string, T>): Map<string, T> =>
    new Map([...map].map(([path, v]) => [path.slice(CHECKOUT.length + 1), v]));
  return { text: relative(text), binary: relative(binary) };
}

// What `corpus pull --all` writes for this corpus, as a path → text map
// (documents and `.corpus.json`): the reference the mirror must equal byte
// for byte.
export async function cliCheckout(
  fixture: Fixture,
): Promise<ReadonlyMap<string, string>> {
  return (await pullCheckout(fixture)).text;
}

// The same checkout as exact bytes, images and attachments included.
export async function cliCheckoutBytes(
  fixture: Fixture,
): Promise<ReadonlyMap<string, Uint8Array>> {
  const { text, binary } = await pullCheckout(fixture);
  const encoder = new TextEncoder();
  return new Map([
    ...[...text].map(([path, body]) => [path, encoder.encode(body)] as const),
    ...binary,
  ]);
}

// Store an image or attachment in the corpus at a corpus-relative path, the
// way an upload does: bytes into R2 first, then the metadata through the DO.
export async function putAsset(
  fixture: Fixture,
  path: string,
  bytes: Uint8Array<ArrayBuffer>,
  baseHash?: string,
): Promise<string> {
  if (env.FILES === undefined) throw new Error("fixture: FILES is not bound");
  const format = sniffFormat(bytes);
  if (format === undefined) throw new Error(`fixture: ${path} is not an image`);
  const contentHash = await sha256Hex(bytes);
  await r2ObjectStore(env.FILES).put(
    fileObjectKey(fixture.projectId, contentHash),
    bytes,
  );
  const result = await fixture.store.putFileAtPath({
    corpusSlug: fixture.corpusSlug,
    path,
    contentHash,
    size: bytes.byteLength,
    format,
    baseHash,
    changedBy: fixture.ownerUserId,
  });
  if (!result.ok) {
    throw new Error(`fixture: could not store ${path}: ${result.reason}`);
  }
  return result.file.slug;
}

// Every file of one commit's tree, as exact bytes.
export async function readCommitFiles(
  repoName: string,
  treeHash: string,
): Promise<ReadonlyMap<string, Uint8Array>> {
  const repo = await artifacts().get(repoName);
  using _repo = repo;
  const files = new Map<string, string>();
  const bytes = new Map<string, Uint8Array>();
  await walk(repo, treeHash, "", { files, bytes });
  return bytes;
}

// Run the drain to completion — the same method the DO alarm calls.
export async function settle(fixture: Fixture): Promise<void> {
  await fixture.store.drainGitMirror();
}

type MirrorRow = Readonly<{
  corpus_slug: string;
  intent: string;
  generation: number;
  synced_generation: number;
  attempts: number;
  retry_at: number | null;
  last_error: string | null;
  last_commit: string | null;
}>;

export function mirrorRows(fixture: Fixture): Promise<readonly MirrorRow[]> {
  return runInDurableObject(fixture.store, (_instance, state) =>
    state.storage.sql
      .exec<MirrorRow>(
        "select corpus_slug, intent, generation, synced_generation, attempts, retry_at, last_error, last_commit from mirror_state order by corpus_slug",
      )
      .toArray(),
  );
}

// Make a failed row due again now (the backoff is wall-clock time).
export async function makeDue(fixture: Fixture): Promise<void> {
  await runInDurableObject(fixture.store, (_instance, state) => {
    state.storage.sql.exec("update mirror_state set retry_at = null");
  });
}

export async function postCloneToken(token: string): Promise<Response> {
  return SELF.fetch(`${BASE_URL}/api/v1/git/token`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}
