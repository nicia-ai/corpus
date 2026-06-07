import { z } from "zod";

// Portable Corpus CLI core: the list / pull / push logic over the api-key
// REST surface (`/api/v1/docs`), with ZERO runtime-specific imports. It
// speaks only the web `fetch` standard and a tiny injected filesystem
// port, so the same code runs under Node, Deno, Bun, Cloudflare Workers,
// or a WASM host — each supplies its own adapter. The Node entry point
// (`cli/corpus.ts`) wires `node:fs` + `node:process` to this core; tests
// wire an in-memory file map + the test worker's `fetch`.

// A `fetch` accepting a string URL — the narrow shape the core needs. The
// global `fetch` (and a Worker `Fetcher.fetch`) is assignable to it.
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

// The host filesystem, abstracted to text read/write by path. `readText`
// resolves to `undefined` when the path is absent (it never throws for
// "not found"), so the missing-sidecar / missing-file case is data, not an
// exception — which keeps the core's control flow host-agnostic.
export type Files = Readonly<{
  readText: (path: string) => Promise<string | undefined>;
  writeText: (path: string, data: string) => Promise<void>;
}>;

export type CorpusConfig = Readonly<{
  baseUrl: string;
  apiKey: string;
  fetch: FetchLike;
  files: Files;
}>;

const DocSummarySchema = z.object({
  slug: z.string(),
  title: z.string(),
  docVersion: z.number(),
});
const DocListSchema = z.object({ documents: z.array(DocSummarySchema) });
const DocFullSchema = z.object({
  slug: z.string(),
  title: z.string(),
  markdown: z.string(),
  docVersion: z.number(),
});
const PushResultSchema = z.object({
  ok: z.boolean().optional(),
  docVersion: z.number().optional(),
  currentVersion: z.number().optional(),
});
const SidecarSchema = z.object({ slug: z.string(), docVersion: z.number() });

export type DocSummary = Readonly<z.infer<typeof DocSummarySchema>>;
export type DocFull = Readonly<z.infer<typeof DocFullSchema>>;

// A failure the Node shell maps to a message + exit code. `kind`
// classifies it; `detail` carries the structured fields the shell may want
// (HTTP status, the server's current version on a conflict).
export type CliErrorKind = "not-found" | "conflict" | "http" | "mismatch";

export class CliError extends Error {
  constructor(
    readonly kind: CliErrorKind,
    message: string,
    readonly detail: Readonly<{
      status?: number;
      currentVersion?: number;
    }> = {},
  ) {
    super(message);
    this.name = "CliError";
  }
}

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

async function request(
  cfg: CorpusConfig,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${cfg.apiKey}`);
  return cfg.fetch(`${cfg.baseUrl}${path}`, { ...init, headers });
}

export async function list(cfg: CorpusConfig): Promise<readonly DocSummary[]> {
  const res = await request(cfg, "/api/v1/docs");
  if (!res.ok) {
    throw new CliError("http", `list failed (${res.status})`, {
      status: res.status,
    });
  }
  return DocListSchema.parse(await res.json()).documents;
}

export async function pull(
  cfg: CorpusConfig,
  slug: string,
  path?: string,
): Promise<Readonly<{ file: string; doc: DocFull }>> {
  const file = path ?? `${slug}.md`;
  const res = await request(cfg, `/api/v1/docs/${encodeURIComponent(slug)}`);
  if (res.status === 404) {
    throw new CliError("not-found", `not found: ${slug}`, { status: 404 });
  }
  if (!res.ok) {
    throw new CliError("http", `pull failed (${res.status})`, {
      status: res.status,
    });
  }
  const doc = DocFullSchema.parse(await res.json());
  await cfg.files.writeText(file, doc.markdown);
  await cfg.files.writeText(
    sidecarPath(file),
    serializeSidecar(doc.slug, doc.docVersion),
  );
  return { file, doc };
}

export async function push(
  cfg: CorpusConfig,
  slug: string,
  path?: string,
): Promise<Readonly<{ file: string; docVersion: number }>> {
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
  const clientVersion = sidecar?.docVersion ?? 0;
  const res = await request(cfg, `/api/v1/docs/${encodeURIComponent(slug)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ markdown, clientVersion }),
  });
  const body = PushResultSchema.parse(await res.json());
  if (res.status === 409) {
    throw new CliError(
      "conflict",
      `conflict: the document is at v${body.currentVersion ?? 0}. ` +
        "Pull, reapply your change, and push again.",
      { status: 409, currentVersion: body.currentVersion },
    );
  }
  if (!res.ok || body.ok !== true || body.docVersion === undefined) {
    throw new CliError("http", `push failed (${res.status})`, {
      status: res.status,
    });
  }
  await cfg.files.writeText(
    sidecarPath(file),
    serializeSidecar(slug, body.docVersion),
  );
  return { file, docVersion: body.docVersion };
}
