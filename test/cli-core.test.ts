import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  CliError,
  type CorpusConfig,
  type Files,
  type FetchLike,
  list,
  pull,
  push,
  readClientVersion,
  sidecarPath,
} from "../cli/core";
import {
  apiKeyDisplayPrefix,
  generateApiKeyToken,
  hashApiKeyToken,
} from "../src/control/api-keys";
import { connectControlDb } from "../src/control/db";
import { apiKey } from "../src/control/schema/app";
import { storeFor } from "../src/control/store-for";
import type { ProjectId } from "../src/ids";

import {
  createCollectionFor,
  createConnection,
  createOrg,
  docSlug,
  signUp,
} from "./_helpers";

const MEMBER_SLUG = "member-doc";
const OUTSIDER_SLUG = "outsider-doc";

// The core speaks the web `fetch` standard; in the Workers test pool we
// point it at the running worker via SELF, with an absolute base URL.
const BASE_URL = "https://example.com";
const fetchLike: FetchLike = (input, init) => SELF.fetch(input, init);

// An in-memory `Files` adapter — the host port the core writes the markdown
// file + version sidecar through, so the CLI's I/O logic is exercised with
// zero node:fs and the written bytes are inspectable.
function memoryFiles(): Files & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    readText: (path) => Promise.resolve(map.get(path)),
    writeText: (path, data) => {
      map.set(path, data);
      return Promise.resolve();
    },
  };
}

// Mint an api-key bound to a fresh Connection, seed the per-Project DO with
// a collection member + an outsider document (mirrors cli-rest.test.ts).
async function setup(): Promise<
  Readonly<{
    cfg: CorpusConfig;
    files: ReturnType<typeof memoryFiles>;
    projectId: ProjectId;
  }>
> {
  const ownerUserId = await signUp("cli");
  const db = connectControlDb(env.DB);
  const ref = await createOrg(ownerUserId, "Org cli");
  const conn = await createConnection({
    organizationId: ref.organizationId,
    projectId: ref.projectId,
  });
  await createCollectionFor(ref.projectId, conn.collectionSlug);

  const store = storeFor(env, ref.projectId);
  await store.saveDocument({
    slug: docSlug(MEMBER_SLUG),
    markdown: "# Member\n\nseed",
    clientVersion: 0,
    changedBy: ownerUserId,
  });
  await store.attachDocument(
    conn.collectionSlug,
    docSlug(MEMBER_SLUG),
    0,
    ownerUserId,
  );
  await store.saveDocument({
    slug: docSlug(OUTSIDER_SLUG),
    markdown: "secret",
    clientVersion: 0,
    changedBy: ownerUserId,
  });

  const token = generateApiKeyToken();
  await db.insert(apiKey).values({
    userId: ownerUserId,
    organizationId: ref.organizationId,
    connectionId: conn.connectionId,
    name: "cli",
    tokenHash: await hashApiKeyToken(token),
    tokenPrefix: apiKeyDisplayPrefix(token),
  });

  const files = memoryFiles();
  return {
    cfg: { baseUrl: BASE_URL, apiKey: token, fetch: fetchLike, files },
    files,
    projectId: ref.projectId,
  };
}

describe("CLI core (portable list/pull/push over the REST surface)", () => {
  it("readClientVersion: absent → 0, malformed → 0, valid → its version", async () => {
    const files = memoryFiles();
    expect(await readClientVersion(files, "x.md")).toBe(0);
    await files.writeText(sidecarPath("x.md"), "not json");
    expect(await readClientVersion(files, "x.md")).toBe(0);
    await files.writeText(
      sidecarPath("x.md"),
      JSON.stringify({ slug: "x", docVersion: 7 }),
    );
    expect(await readClientVersion(files, "x.md")).toBe(7);
  });

  it("list returns only the bound collection's members", async () => {
    const { cfg } = await setup();
    const slugs = (await list(cfg)).map((d) => d.slug);
    expect(slugs).toContain(MEMBER_SLUG);
    expect(slugs).not.toContain(OUTSIDER_SLUG);
  });

  it("pull writes the markdown file + a version sidecar", async () => {
    const { cfg, files } = await setup();
    const { file, doc } = await pull(cfg, MEMBER_SLUG);
    expect(file).toBe(`${MEMBER_SLUG}.md`);
    expect(doc.docVersion).toBe(1);
    expect(files.map.get(file)).toBe("# Member\n\nseed");
    expect(JSON.parse(files.map.get(sidecarPath(file)) ?? "{}")).toMatchObject({
      slug: MEMBER_SLUG,
      docVersion: 1,
    });
  });

  it("pull of a document outside the collection throws not-found", async () => {
    const { cfg } = await setup();
    await expect(pull(cfg, OUTSIDER_SLUG)).rejects.toMatchObject({
      name: "CliError",
      kind: "not-found",
    });
  });

  it("pull → edit → push round-trips and advances the sidecar version", async () => {
    const { cfg, files } = await setup();
    const { file } = await pull(cfg, MEMBER_SLUG);
    files.map.set(file, "# Member\n\nedited");
    const r = await push(cfg, MEMBER_SLUG);
    expect(r.docVersion).toBe(2);
    expect(await readClientVersion(files, file)).toBe(2);

    // A second edit pushes cleanly because the sidecar tracked the new head.
    files.map.set(file, "# Member\n\nedited again");
    expect((await push(cfg, MEMBER_SLUG)).docVersion).toBe(3);
  });

  it("push surfaces a 409 conflict when the head moved under the sidecar", async () => {
    const { cfg, files, projectId } = await setup();
    const { file } = await pull(cfg, MEMBER_SLUG); // sidecar at v1
    // Someone else advances the document to v2 out-of-band.
    await storeFor(env, projectId).saveDocument({
      slug: docSlug(MEMBER_SLUG),
      markdown: "# Member\n\nupstream change",
      clientVersion: 1,
      changedBy: "other",
    });
    files.map.set(file, "# Member\n\nmy stale change");
    const err = await push(cfg, MEMBER_SLUG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(err).toMatchObject({
      kind: "conflict",
      detail: { currentVersion: 2 },
    });
    expect((err as CliError).message).toContain("v2");
  });

  it("push creates a brand-new document into the bound collection", async () => {
    const { cfg, files } = await setup();
    files.map.set("onboarding.md", "# Onboarding\n\nwelcome");
    const r = await push(cfg, "onboarding", "onboarding.md");
    expect(r.docVersion).toBe(1);
    // It now lists, reads back, and the sidecar was written.
    expect((await list(cfg)).map((d) => d.slug)).toContain("onboarding");
    expect(await readClientVersion(files, "onboarding.md")).toBe(1);
    const pulled = await pull(cfg, "onboarding", "onboarding.md");
    expect(pulled.doc.markdown).toBe("# Onboarding\n\nwelcome");
  });

  it("push of a missing local file throws not-found", async () => {
    const { cfg } = await setup();
    await expect(push(cfg, MEMBER_SLUG, "nope.md")).rejects.toMatchObject({
      name: "CliError",
      kind: "not-found",
    });
  });

  it("push refuses a sidecar that tracks a different document", async () => {
    const { cfg, files } = await setup();
    // A copied/renamed pair: the file is `renamed.md` but its sidecar still
    // records `member-doc`. Pushing as `renamed` must NOT borrow member-doc's
    // version (which could overwrite the wrong document).
    files.map.set("renamed.md", "# Renamed\n\nbody");
    files.map.set(
      sidecarPath("renamed.md"),
      JSON.stringify({ slug: MEMBER_SLUG, docVersion: 1 }),
    );
    await expect(push(cfg, "renamed", "renamed.md")).rejects.toMatchObject({
      name: "CliError",
      kind: "mismatch",
    });
  });
});
