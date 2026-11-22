import type { ProjectId } from "../../ids";

// The narrow port over the bytes of uploaded files. The only implementation
// is R2 (`r2ObjectStore`); a port, like `GitMirror`, so a test can inject a
// failure at the one seam where bytes and metadata can disagree, and so
// nothing but this file and its factory knows R2's API.
//
// Keys are `p/<projectId>/<sha256hex>`. The prefix is the tenant boundary: a
// key can only be built from a `ProjectId` the caller was already authorized
// for (`storeFor(env, projectId)`), and dedupe is project-local, so one
// project can never learn that another holds a given file.

const PROJECT_PREFIX = "p/";

export function projectObjectPrefix(projectId: ProjectId): string {
  return `${PROJECT_PREFIX}${projectId}/`;
}

export function fileObjectKey(projectId: ProjectId, hash: string): string {
  return `${projectObjectPrefix(projectId)}${hash}`;
}

// The hash an object key names, or undefined for a key outside the shape.
export function hashOfObjectKey(
  projectId: ProjectId,
  key: string,
): string | undefined {
  const prefix = projectObjectPrefix(projectId);
  return key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
}

export type StoredObject = Readonly<{
  key: string;
  // Epoch milliseconds of the last put. The orphan sweep's grace window keys
  // on it, which is why an upload re-puts even a key that already exists.
  uploadedMs: number;
}>;

export type ObjectPage = Readonly<{
  objects: readonly StoredObject[];
  cursor: string | undefined;
}>;

export type ObjectBody = Readonly<{
  body: ReadableStream;
  size: number;
}>;

export type ObjectStore = Readonly<{
  put: (key: string, bytes: Uint8Array) => Promise<void>;
  get: (key: string) => Promise<ObjectBody | undefined>;
  // Metadata only; the sweep re-checks freshness just before it deletes.
  head: (key: string) => Promise<StoredObject | undefined>;
  list: (prefix: string, cursor?: string) => Promise<ObjectPage>;
  // R2 deletes up to 1000 keys per call; callers batch.
  delete: (keys: readonly string[]) => Promise<void>;
}>;

export const OBJECT_DELETE_BATCH = 1000;

export function r2ObjectStore(bucket: R2Bucket): ObjectStore {
  return {
    put: async (key, bytes) => {
      await bucket.put(key, bytes);
    },
    get: async (key) => {
      const object = await bucket.get(key);
      return object === null
        ? undefined
        : { body: object.body, size: object.size };
    },
    head: async (key) => {
      const object = await bucket.head(key);
      return object === null
        ? undefined
        : { key: object.key, uploadedMs: object.uploaded.getTime() };
    },
    list: async (prefix, cursor) => {
      const page = await bucket.list({
        prefix,
        ...(cursor === undefined ? {} : { cursor }),
      });
      return {
        objects: page.objects.map((object) => ({
          key: object.key,
          uploadedMs: object.uploaded.getTime(),
        })),
        cursor: page.truncated ? page.cursor : undefined,
      };
    },
    delete: async (keys) => {
      await bucket.delete([...keys]);
    },
  };
}
