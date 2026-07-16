import { z } from "zod";

// — Strings ————————————————————————————————————————————————

// The slug transform without the empty-string fallback, so callers
// that slugify path segments can fold the fallback once post-join.
export function slugifyToken(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function slugify(input: string): string {
  const slug = slugifyToken(input);
  return slug.length > 0 ? slug : `doc-${stableHash(input)}`;
}

// The document's display title inferred from its body: the first H1
// heading, else the caller's fallback (the filename / slug). The caller
// supplies a frontmatter `title` ahead of this and strips the YAML fence
// before calling, so a leading `---` is never mistaken for a title.
export function inferTitle(markdown: string, fallback: string): string {
  const heading = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim();
  return heading !== undefined && heading.length > 0 ? heading : fallback;
}

// — Hashing & ids ——————————————————————————————————————————

// FNV-1a 32-bit. Stable across runs; not cryptographic.
export function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// Approximate token count. Deliberately a cheap chars/4 heuristic — NOT
// a tokenizer dependency in the Worker bundle (design Perf decision).
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// UTF-8 byte length of a string — the unit quota/usage is measured in, not
// `.length` (which counts UTF-16 code units). Shared so the markdown-size
// accounting is identical wherever it's computed.
export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

// Whitespace-or-empty, the one blank test shared by text anchoring and the
// suggestion splice so "blank" can never mean two different things.
export function isBlank(text: string): boolean {
  return text.trim() === "";
}

// Format an integer with US-style thousands separators. Pinned to
// `en-US` so SSR (Workers, no locale) and the browser (user's locale)
// render byte-identical strings — `toLocaleString()` without a locale
// argument is a hydration desync waiting to happen.
const NUMBER_FORMAT = new Intl.NumberFormat("en-US");
export function formatNumber(n: number): string {
  return NUMBER_FORMAT.format(n);
}

// English count-with-noun: "1 document" / "2 documents". The dozens of
// `count === 1 ? "" : "s"` sites across the UI all want this; one place
// to touch when copy or future i18n moves.
export function pluralize(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? "" : "s"}`;
}

// Default per-collection always-include budget assigned to new
// collections (the Collection node's `alwaysIncludeBudgetTokens` field).
// The budget is authoring-side guidance only — the BudgetMeter in the
// edit pane compares the assembled `delivery=core` set against it; MCP
// `read_collection` never enforces. Owners with a larger context window
// can raise it per-collection.
export const DEFAULT_ALWAYS_INCLUDE_BUDGET_TOKENS = 8000;

// Hard upper bound shared across the client form, the updateCollection
// server-fn validator, the bundle schema, and the TypeGraph node — so a
// scripted caller, a tampered bundle, or a future bug can't persist a
// nonsense value that breaks the meter forever. Past today's largest
// known context window (Gemini 1M), so legitimate owners never trip it.
export const MAX_ALWAYS_INCLUDE_BUDGET_TOKENS = 1_000_000;

// THE single Zod field for `alwaysIncludeBudgetTokens` — the TypeGraph
// node schema (`src/graph.ts`), the `updateCollection` server-fn input
// validator (`src/lib/server/collections.ts`), and the bundle Collection
// + Manifest schemas (`src/store/domain/bundle.ts`) all reference this
// so the bound can never drift between the four trust boundaries.
export const alwaysIncludeBudgetTokensZ = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_ALWAYS_INCLUDE_BUDGET_TOKENS);

// Sum of per-document token estimates for an assembled collection — the
// value the BudgetMeter compares against the collection's configured
// `alwaysIncludeBudgetTokens`.
export function manifestTokens(
  items: readonly { readonly size: number }[],
): number {
  return items.reduce((n, d) => n + d.size, 0);
}

// Content address for a blob: `sha256:<lowercase-hex>`. Web Crypto
// (available in the Workers runtime); the prefix is part of the stored
// hash and the bundle contract, so callers compare prefixed strings.
export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

// — Compression ————————————————————————————————————————————

// gzip a string with the Workers-native `CompressionStream` (no Node
// `zlib` import — this is the runtime-idiomatic path and keeps the bundle
// thin). Used only for at-rest blob storage; the content hash is always
// taken over the uncompressed markdown, so this never touches the
// content-address, dedup, verifier, or bundle contract.
export async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzip(data: Uint8Array): Promise<string> {
  const stream = new Blob([new Uint8Array(data)])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

// — Objects ———————————————————————————————————————————————

// Drop keys whose value is `undefined`. Pair with `exactOptionalPropertyTypes`
// so optional fields can be assembled inline without spread guards.
export type Compact<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<
    T[K],
    undefined
  >;
};

export function compact<T extends object>(value: T): Compact<T> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item !== undefined) out[key] = item;
  }
  return out as Compact<T>;
}
