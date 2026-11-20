import { z } from "zod";

import { CliError } from "./errors.js";
import { CLI_GRANTS, DEFAULT_GRANT, type Grant } from "./grant.js";
import { type ApiConfig, request } from "./http.js";
import { type ProposalReceipt, putDocument } from "./rest-write.js";
import {
  type CorpusIdentity,
  parseState,
  serializeState,
  sha256Hex,
  stateCandidates,
  type SyncState,
  type TrackedFile,
} from "./sync-state.js";

export { CliError, type CliErrorKind } from "./errors.js";
export type { FetchLike } from "./http.js";

// Portable Corpus CLI core: the list / pull / push logic over the api-key
// REST surface (`/api/v1/docs`), with ZERO runtime-specific imports. It
// speaks only the web `fetch` standard and a tiny injected filesystem
// port, so the same code runs under Node, Deno, Bun, Cloudflare Workers,
// or a WASM host — each supplies its own adapter. The Node entry point
// (`cli/corpus.ts`) wires `node:fs` + `node:process` to this core; tests
// wire an in-memory file map + the test worker's `fetch`.

// The host filesystem, abstracted to text read/write by path. `readText`
// resolves to `undefined` when the path is absent (it never throws for
// "not found"), so the missing-sidecar / missing-file case is data, not an
// exception — which keeps the core's control flow host-agnostic.
export type Files = Readonly<{
  readText: (path: string) => Promise<string | undefined>;
  writeText: (path: string, data: string) => Promise<void>;
}>;

// The filesystem a whole-corpus sync needs: `Files` plus deletion. Writing
// a nested path must create its parent folders; removing an absent path is
// not an error.
export type TreeFiles = Files &
  Readonly<{ remove: (path: string) => Promise<void> }>;

export type CorpusConfig = Readonly<ApiConfig & { files: Files }>;

export type SyncConfig = Readonly<
  Omit<CorpusConfig, "files"> & { files: TreeFiles }
>;

const DocSummarySchema = z.object({
  slug: z.string(),
  title: z.string(),
  docVersion: z.number(),
  // Absent from servers that predate whole-corpus sync.
  path: z.string().optional(),
});
const DocListSchema = z.object({
  corpus: z.object({ projectId: z.string(), slug: z.string() }).optional(),
  // Absent from servers that predate grants.
  grant: z.enum(CLI_GRANTS).optional(),
  documents: z.array(DocSummarySchema),
});
const DocFullSchema = z.object({
  slug: z.string(),
  title: z.string(),
  markdown: z.string(),
  docVersion: z.number(),
});
const SidecarSchema = z.object({ slug: z.string(), docVersion: z.number() });

export type DocSummary = Readonly<z.infer<typeof DocSummarySchema>>;
export type DocFull = Readonly<z.infer<typeof DocFullSchema>>;

export type DoctorResult = Readonly<{
  documentCount: number;
}>;

// Where a document's version sidecar lives, given its markdown file path.
export function sidecarPath(file: string): string {
  return `${file}.corpus.json`;
}

export type Sidecar = Readonly<z.infer<typeof SidecarSchema>>;

// The parsed sidecar beside a markdown file, or `undefined` when it is
// absent or unreadable. It records BOTH the slug and the version, so a
// push can refuse to write a file whose sidecar belongs to a different
// document (a copied or renamed pair).
export async function readSidecar(
  files: Files,
  file: string,
): Promise<Sidecar | undefined> {
  const raw = await files.readText(sidecarPath(file));
  if (raw === undefined) return undefined;
  try {
    return SidecarSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

// The base version a push starts from: the version recorded in the sidecar,
// or 0 (a fresh document) when there is no sidecar or it is unreadable.
export async function readClientVersion(
  files: Files,
  file: string,
): Promise<number> {
  return (await readSidecar(files, file))?.docVersion ?? 0;
}

function serializeSidecar(slug: string, docVersion: number): string {
  return `${JSON.stringify({ slug, docVersion })}\n`;
}

export type CorpusListing = Readonly<{
  corpus: CorpusIdentity | undefined;
  // What the key may do. A server that predates grants lets a key write.
  grant: Grant;
  documents: readonly DocSummary[];
}>;

export async function listCorpus(cfg: CorpusConfig): Promise<CorpusListing> {
  const res = await request(cfg, "/api/v1/docs");
  if (!res.ok) {
    throw new CliError("http", `list failed (${res.status})`, {
      status: res.status,
    });
  }
  const body = DocListSchema.parse(await res.json());
  return {
    corpus: body.corpus,
    grant: body.grant ?? DEFAULT_GRANT,
    documents: body.documents,
  };
}

export async function list(cfg: CorpusConfig): Promise<readonly DocSummary[]> {
  return (await listCorpus(cfg)).documents;
}

export async function fetchDocument(
  cfg: CorpusConfig,
  slug: string,
): Promise<DocFull> {
  const res = await request(cfg, `/api/v1/docs/${encodeURIComponent(slug)}`);
  if (res.status === 404) {
    throw new CliError("not-found", `not found: ${slug}`, { status: 404 });
  }
  if (!res.ok) {
    throw new CliError("http", `pull failed (${res.status})`, {
      status: res.status,
    });
  }
  return DocFullSchema.parse(await res.json());
}

// A file that a `pull --all` checkout tracks in its `.corpus.json` state
// file. In such a checkout the state file, not a per-file sidecar, records a
// document's base version, so single-document pull/push and `pull --all`
// agree about what has been synced.
type TrackedLocation = Readonly<{
  statePath: string;
  state: SyncState;
  entry: TrackedFile;
}>;

// The nearest state file above `file` governs it. `undefined` when there is
// none or `file` is not one of its tracked paths; a tracked path owned by a
// different document is a copied or renamed file, refused like a sidecar
// mismatch.
async function findTracked(
  files: Files,
  file: string,
  slug: string,
): Promise<TrackedLocation | undefined> {
  for (const { statePath, relPath } of stateCandidates(file)) {
    const raw = await files.readText(statePath);
    if (raw === undefined) continue;
    const state = parseState(raw, statePath);
    const entry = state.files.find((f) => f.path === relPath);
    if (entry === undefined) return undefined;
    if (entry.slug !== slug) {
      throw new CliError(
        "mismatch",
        `${statePath} tracks "${entry.slug}" at ${relPath}, not "${slug}" — ` +
          "refusing (copied or renamed file?).",
      );
    }
    return { statePath, state, entry };
  }
  return undefined;
}

async function recordTracked(
  files: Files,
  tracked: TrackedLocation,
  docVersion: number,
  markdown: string,
): Promise<void> {
  const entry = {
    ...tracked.entry,
    docVersion,
    sha256: await sha256Hex(markdown),
  };
  const state = {
    ...tracked.state,
    files: tracked.state.files.map((f) => (f.path === entry.path ? entry : f)),
  };
  await files.writeText(tracked.statePath, serializeState(state));
}

export async function doctor(
  cfg: CorpusConfig,
  timeoutMs = 5000,
): Promise<DoctorResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const documents = await list({
      ...cfg,
      fetch: (input, init) =>
        cfg.fetch(input, { ...init, signal: controller.signal }),
    });
    return { documentCount: documents.length };
  } finally {
    clearTimeout(timeout);
  }
}

export async function pull(
  cfg: CorpusConfig,
  slug: string,
  path?: string,
): Promise<Readonly<{ file: string; doc: DocFull }>> {
  const file = path ?? `${slug}.md`;
  const doc = await fetchDocument(cfg, slug);
  const tracked = await findTracked(cfg.files, file, slug);
  await cfg.files.writeText(file, doc.markdown);
  if (tracked === undefined) {
    await cfg.files.writeText(
      sidecarPath(file),
      serializeSidecar(doc.slug, doc.docVersion),
    );
  } else {
    await recordTracked(cfg.files, tracked, doc.docVersion, doc.markdown);
  }
  return { file, doc };
}

export type PushResult = Readonly<
  | { file: string; docVersion: number; proposal?: undefined }
  // A `suggest` key sends the change as a proposal. Nothing canonical has
  // changed, so the sidecar / state file is left as it was: the file still
  // reads as a local edit until the proposal is applied and pulled.
  | { file: string; docVersion?: undefined; proposal: ProposalReceipt }
>;

export type PushOptions = Readonly<{
  // Corpus-relative path for a NEW document (missing folders are created).
  // Ignored by the server for a document that already exists.
  docPath?: string;
}>;

export async function push(
  cfg: CorpusConfig,
  slug: string,
  path?: string,
  options: PushOptions = {},
): Promise<PushResult> {
  const file = path ?? `${slug}.md`;
  const markdown = await cfg.files.readText(file);
  if (markdown === undefined)
    throw new CliError("not-found", `no such file: ${file}`);
  const sidecar = await readSidecar(cfg.files, file);
  if (sidecar !== undefined && sidecar.slug !== slug) {
    // The sidecar tracks a different document — a copied or renamed file.
    // Its version is meaningless for this slug and could overwrite the
    // wrong document if the numbers happen to line up. Refuse.
    throw new CliError(
      "mismatch",
      `${sidecarPath(file)} tracks "${sidecar.slug}", not "${slug}" — ` +
        "refusing to push (copied or renamed file?). Delete the sidecar to push as new.",
    );
  }
  const tracked =
    sidecar === undefined
      ? await findTracked(cfg.files, file, slug)
      : undefined;
  const clientVersion = sidecar?.docVersion ?? tracked?.entry.docVersion ?? 0;
  const outcome = await putDocument(cfg, {
    slug,
    markdown,
    clientVersion,
    path: options.docPath,
  });
  switch (outcome.kind) {
    case "written":
      break;
    case "proposed":
      return { file, proposal: outcome.proposal };
    case "unchanged":
      throw new CliError(
        "unsupported",
        "nothing to propose: the document already has exactly this content.",
      );
    case "path-taken":
      throw new CliError(
        "conflict",
        "conflict: that slug collides with an existing file or folder path.",
        { status: 409 },
      );
    case "rolled-back":
      throw new CliError(
        "conflict",
        "conflict: the write could not be completed atomically. Retry it.",
        { status: 409 },
      );
    case "conflict":
      throw new CliError(
        "conflict",
        `conflict: the document is at v${outcome.currentVersion ?? 0}. ` +
          "Pull, reapply your change, and push again.",
        {
          status: 409,
          ...(outcome.currentVersion === undefined
            ? {}
            : { currentVersion: outcome.currentVersion }),
        },
      );
    case "gone":
      throw new CliError("http", "push failed (404): not found", {
        status: 404,
      });
    case "refused":
      throw new CliError(
        "http",
        `push failed (${String(outcome.status)}): ${outcome.message}`,
        { status: outcome.status },
      );
    default:
      throw new CliError("http", "push failed (unexpected response)");
  }
  if (sidecar === undefined && tracked !== undefined) {
    await recordTracked(cfg.files, tracked, outcome.docVersion, markdown);
  } else {
    await cfg.files.writeText(
      sidecarPath(file),
      serializeSidecar(slug, outcome.docVersion),
    );
  }
  return { file, docVersion: outcome.docVersion };
}
