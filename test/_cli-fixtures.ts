import { env, SELF } from "cloudflare:test";
import { expect } from "vitest";

import type { FetchLike } from "../cli/core";
import type { PushConfig, PushFiles } from "../cli/push-all";
import {
  apiKeyDisplayPrefix,
  generateApiKeyToken,
  hashApiKeyToken,
} from "../src/control/api-keys";
import { connectControlDb } from "../src/control/db";
import { apiKey } from "../src/control/schema/app";
import { storeFor } from "../src/control/store-for";
import type { Grant } from "../src/grant";
import { asFolderSlug, type CorpusSlug, type ProjectId } from "../src/ids";
import { DEFAULT_CORPUS_SLUG } from "../src/store/domain/default-corpus";

import {
  createConnection,
  createCorpusFor,
  createOrg,
  docSlug,
  signUp,
} from "./_helpers";

// Fixtures shared by the CLI tests that run the portable core against the
// test worker: a project with one corpus, an api key bound to it (with a
// chosen grant), and an in-memory working tree.

export const BASE_URL = "https://example.com";
export const DIR = "checkout";
export const OWNER = "sync-owner";

export type MemoryTree = PushFiles &
  Readonly<{ map: Map<string, string>; writes: string[]; removes: string[] }>;

// In-memory TreeFiles that records every mutation, so "writes nothing" is an
// assertion on the log rather than on file contents alone.
export function memoryTree(): MemoryTree {
  const map = new Map<string, string>();
  const writes: string[] = [];
  const removes: string[] = [];
  return {
    map,
    writes,
    removes,
    readText: (path) => Promise.resolve(map.get(path)),
    writeText: (path, data) => {
      writes.push(path);
      map.set(path, data);
      return Promise.resolve();
    },
    remove: (path) => {
      removes.push(path);
      map.delete(path);
      return Promise.resolve();
    },
    listFiles: (dir) => {
      const prefix = `${dir}/`;
      return Promise.resolve(
        [...map.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => key.slice(prefix.length)),
      );
    },
  };
}

export const sameWorkerFetch: FetchLike = (input, init) =>
  SELF.fetch(input, init);

export type Corpus = Readonly<{
  token: string;
  corpusSlug: CorpusSlug;
  projectId: ProjectId;
  organizationId: Parameters<typeof createConnection>[0]["organizationId"];
  ownerUserId: Awaited<ReturnType<typeof signUp>>;
}>;

export async function mintKey(
  ownerUserId: Corpus["ownerUserId"],
  organizationId: Corpus["organizationId"],
  connectionId: Awaited<ReturnType<typeof createConnection>>["connectionId"],
  grant: Grant,
): Promise<string> {
  const token = generateApiKeyToken();
  await connectControlDb(env.DB)
    .insert(apiKey)
    .values({
      userId: ownerUserId,
      organizationId,
      connectionId,
      name: "sync",
      tokenHash: await hashApiKeyToken(token),
      tokenPrefix: apiKeyDisplayPrefix(token),
      grant,
    });
  return token;
}

export async function newCorpus(grant: Grant = "edit"): Promise<Corpus> {
  const ownerUserId = await signUp("sync");
  const ref = await createOrg(ownerUserId, "Org sync");
  const conn = await createConnection({
    organizationId: ref.organizationId,
    projectId: ref.projectId,
  });
  await createCorpusFor(ref.projectId, conn.corpusSlug);
  return {
    token: await mintKey(
      ownerUserId,
      ref.organizationId,
      conn.connectionId,
      grant,
    ),
    corpusSlug: conn.corpusSlug,
    projectId: ref.projectId,
    organizationId: ref.organizationId,
    ownerUserId,
  };
}

// A second corpus (and key) in the same project as `corpus`.
export async function siblingCorpus(
  corpus: Corpus,
  grant: Grant = "edit",
): Promise<Corpus> {
  const conn = await createConnection({
    organizationId: corpus.organizationId,
    projectId: corpus.projectId,
  });
  await createCorpusFor(corpus.projectId, conn.corpusSlug);
  return {
    ...corpus,
    corpusSlug: conn.corpusSlug,
    token: await mintKey(
      corpus.ownerUserId,
      corpus.organizationId,
      conn.connectionId,
      grant,
    ),
  };
}

export function configFor(
  corpus: Corpus,
  files: MemoryTree,
  fetch: FetchLike = sameWorkerFetch,
): PushConfig {
  return { baseUrl: BASE_URL, apiKey: corpus.token, fetch, files };
}

// Create a document in `corpus`, optionally inside a top-level folder of it.
export async function seed(
  corpus: Corpus,
  slug: string,
  markdown: string,
  folder?: string,
): Promise<void> {
  const store = storeFor(env, corpus.projectId);
  let folderSlug: ReturnType<typeof asFolderSlug> | null = null;
  if (folder !== undefined) {
    const location = { corpusSlug: corpus.corpusSlug, folderSlug: null };
    const created = await store.createFolder(folder, location);
    const existing = (await store.listFolders()).find(
      (f) => f.name === folder && f.corpusSlug === corpus.corpusSlug,
    );
    folderSlug = asFolderSlug(
      created.ok ? created.slug : (existing?.slug ?? ""),
    );
  }
  const r = await store.saveDocument({
    slug: docSlug(slug),
    markdown,
    location: { corpusSlug: corpus.corpusSlug, folderSlug },
    clientVersion: 0,
    changedBy: OWNER,
  });
  expect(r.ok, `seeding ${slug}`).toBe(true);
}

// Take a document out of `corpus`: to drafts (not served) or to another
// corpus's top level.
export async function moveOut(
  corpus: Corpus,
  slug: string,
  to: CorpusSlug = DEFAULT_CORPUS_SLUG,
): Promise<void> {
  const store = storeFor(env, corpus.projectId);
  await store.ensureDefaultCorpus(OWNER);
  const r = await store.moveDocument(
    docSlug(slug),
    { corpusSlug: to, folderSlug: null },
    OWNER,
  );
  expect(r, `moving ${slug} out`).toMatchObject({ ok: true });
}

export async function edit(
  corpus: Corpus,
  slug: string,
  markdown: string,
  clientVersion: number,
): Promise<void> {
  const r = await storeFor(env, corpus.projectId).saveDocument({
    slug: docSlug(slug),
    markdown,
    clientVersion,
    changedBy: OWNER,
  });
  expect(r.ok).toBe(true);
}
