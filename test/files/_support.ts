import { env, SELF } from "cloudflare:test";
import { z } from "zod";

import { storeFor } from "../../src/control/store-for";
import {
  asCorpusSlug,
  asDocumentSlug,
  type CorpusSlug,
  type DocumentSlug,
  type ProjectId,
  type UserId,
} from "../../src/ids";
import type { ProjectStore } from "../../src/project-store";
import {
  type ObjectStore,
  r2ObjectStore,
} from "../../src/store/repos/object-store";
import { sha256Hex } from "../../src/util";
import { createOrg, signUpSession } from "../_helpers";

// A real project (org, signed-in owner, one corpus with one page) with the
// local R2 `FILES` binding: the shape a customer has, so an upload runs the
// whole path — same-origin check, session, sniffing, R2, DO transaction.

export const ORIGIN = "https://example.com";

// The project's R2 port, over the real local bucket. The `files` test
// environment always binds it; a missing binding is a broken fixture.
export function objects(): ObjectStore {
  if (env.FILES === undefined) throw new Error("fixture: FILES is not bound");
  return r2ObjectStore(env.FILES);
}

export type FilesProject = Readonly<{
  projectId: ProjectId;
  userId: UserId;
  cookie: string;
  corpusSlug: CorpusSlug;
  pageSlug: DocumentSlug;
  store: DurableObjectStub<ProjectStore>;
}>;

export async function newFilesProject(
  prefix = "files",
  pagePath = "guide/page.md",
  markdown = "# Page\n",
): Promise<FilesProject> {
  const session = await signUpSession(prefix);
  const org = await createOrg(session.userId, `Org ${prefix}`);
  const store = storeFor(env, org.projectId);
  const corpusSlug = asCorpusSlug(`c-${prefix}`);
  await store.createCorpus({
    slug: corpusSlug,
    name: "Handbook",
    changedBy: session.userId,
  });
  const page = await store.importDocumentAtPath({
    corpusSlug,
    path: pagePath,
    markdown,
    changedBy: session.userId,
  });
  if (!page.ok) throw new Error("fixture: could not create the page");
  return {
    projectId: org.projectId,
    userId: session.userId,
    cookie: session.headers.get("cookie") ?? "",
    corpusSlug,
    pageSlug: asDocumentSlug(page.slug),
    store,
  };
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Distinct bytes per `seed` that the sniffer reads as a PNG.
export function png(seed = "a"): Uint8Array<ArrayBuffer> {
  return new Uint8Array([...PNG_MAGIC, ...new TextEncoder().encode(seed)]);
}

export function jpeg(seed = "a"): Uint8Array<ArrayBuffer> {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    ...new TextEncoder().encode(seed),
  ]);
}

export function pdf(seed = "a"): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`%PDF-1.4\n${seed}\n%%EOF`);
}

export function text(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

export const hashOf = (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  sha256Hex(bytes);

export type UploadOptions = Readonly<{
  name?: string | undefined;
  document?: DocumentSlug;
  project?: ProjectId | string;
  headers?: Readonly<Record<string, string>>;
  // `null` sends no Origin header at all.
  origin?: string | null;
  cookie?: string;
}>;

const UploadBodyZ = z.object({
  name: z.string(),
  path: z.string(),
  url: z.string(),
  contentType: z.string(),
  size: z.number(),
  created: z.boolean(),
});
export type UploadBody = z.infer<typeof UploadBodyZ>;

export function upload(
  project: FilesProject,
  bytes: BodyInit,
  options: UploadOptions = {},
): Promise<Response> {
  const query = new URLSearchParams({
    project: options.project ?? project.projectId,
    document: options.document ?? project.pageSlug,
  });
  if (options.name !== undefined) query.set("name", options.name);
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  return SELF.fetch(`${ORIGIN}/api/files?${query.toString()}`, {
    method: "PUT",
    headers: {
      cookie: options.cookie ?? project.cookie,
      "content-type": "application/octet-stream",
      ...(origin === null ? {} : { origin }),
      ...options.headers,
    },
    body: bytes,
  });
}

export async function uploaded(
  project: FilesProject,
  bytes: BodyInit,
  options: UploadOptions = {},
): Promise<UploadBody> {
  const res = await upload(project, bytes, options);
  if (!res.ok) {
    throw new Error(`fixture: upload failed ${String(res.status)}`);
  }
  return UploadBodyZ.parse(await res.json());
}

export function fetchFile(
  cookie: string,
  projectId: string,
  hash: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/files/${projectId}/${hash}`, {
    headers: { cookie, ...headers },
  });
}
