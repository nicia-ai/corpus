import { MAX_FILE_BYTES } from "../../util";

// The uploaded-file rules, pure and zero-IO: what may be stored, how a type
// is decided, how a name is made safe and unique, and how a stored file may
// be served. The browser imports it too (the file picker's accept list and
// the editor's asset DTO), so nothing here touches the runtime.

// Why a pasted or dropped file was refused. A transport maps each to a
// status; the message is what a person reads.
export type FileRejectionReason =
  | "empty"
  | "too-large"
  | "unsupported-type"
  | "extension-mismatch"
  | "unsafe-svg"
  | "invalid-name";

export type FileRejection = Readonly<{
  reason: FileRejectionReason;
  message: string;
}>;

// `image` renders inline in a page; `attachment` is download-only.
export type FileRole = "image" | "attachment";

export type FileFormat = Readonly<{
  id: "png" | "jpeg" | "gif" | "webp" | "avif" | "svg" | "pdf";
  contentType: string;
  role: FileRole;
  // The extension a name is given when it has none; the rest are accepted.
  extension: string;
  extensions: readonly string[];
}>;

const FORMATS: readonly FileFormat[] = [
  {
    id: "png",
    contentType: "image/png",
    role: "image",
    extension: "png",
    extensions: ["png"],
  },
  {
    id: "jpeg",
    contentType: "image/jpeg",
    role: "image",
    extension: "jpg",
    extensions: ["jpg", "jpeg"],
  },
  {
    id: "gif",
    contentType: "image/gif",
    role: "image",
    extension: "gif",
    extensions: ["gif"],
  },
  {
    id: "webp",
    contentType: "image/webp",
    role: "image",
    extension: "webp",
    extensions: ["webp"],
  },
  {
    id: "avif",
    contentType: "image/avif",
    role: "image",
    extension: "avif",
    extensions: ["avif"],
  },
  {
    id: "svg",
    contentType: "image/svg+xml",
    role: "image",
    extension: "svg",
    extensions: ["svg"],
  },
  {
    id: "pdf",
    contentType: "application/pdf",
    role: "attachment",
    extension: "pdf",
    extensions: ["pdf"],
  },
];

// Every extension a file may carry, for a file picker's `accept`.
export const ALLOWED_FILE_EXTENSIONS: readonly string[] = FORMATS.flatMap(
  (format) => format.extensions,
);

export function formatOfContentType(
  contentType: string,
): FileFormat | undefined {
  return FORMATS.find((format) => format.contentType === contentType);
}

export function formatOfExtension(extension: string): FileFormat | undefined {
  const lower = extension.toLowerCase();
  return FORMATS.find((format) => format.extensions.includes(lower));
}

// — Sniffing ————————————————————————————————————————————————

const startsWith = (bytes: Uint8Array, magic: readonly number[], at = 0) =>
  magic.every((byte, i) => bytes[at + i] === byte);

const ascii = (bytes: Uint8Array, from: number, to: number): string =>
  String.fromCharCode(...bytes.subarray(from, to));

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const AVIF_BRANDS = ["avif", "avis"];
const SVG_SNIFF_BYTES = 2048;

// An SVG is text: after any BOM, whitespace, XML declaration, comments and a
// DOCTYPE without an internal subset, the root element is `<svg`. A DOCTYPE
// with `[` declares entities, so it never matches and the file is refused.
const SVG_PROLOGUE =
  /^(?:\s|<\?xml[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>[]*>)*<svg[\s>/]/i;

function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, SVG_SNIFF_BYTES));
  // The decoder drops a leading BOM itself.
  return SVG_PROLOGUE.test(head);
}

// The format the BYTES say they are. The client's declared type and the
// file's extension are never consulted here.
export function sniffFormat(bytes: Uint8Array): FileFormat | undefined {
  const id = ((): FileFormat["id"] | undefined => {
    if (startsWith(bytes, PNG_MAGIC)) return "png";
    if (startsWith(bytes, JPEG_MAGIC)) return "jpeg";
    const head = ascii(bytes, 0, 6);
    if (head === "GIF87a" || head === "GIF89a") return "gif";
    if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
      return "webp";
    }
    if (
      ascii(bytes, 4, 8) === "ftyp" &&
      AVIF_BRANDS.includes(ascii(bytes, 8, 12))
    ) {
      return "avif";
    }
    if (startsWith(bytes, PDF_MAGIC)) return "pdf";
    return looksLikeSvg(bytes) ? "svg" : undefined;
  })();
  return FORMATS.find((format) => format.id === id);
}

const COMPRESSED_FORMATS: ReadonlySet<FileFormat["id"]> = new Set([
  "png",
  "jpeg",
  "gif",
  "webp",
  "avif",
]);

// True for the raster formats whose bytes are already entropy-coded, so
// deflating them again costs CPU and gains nothing.
export function isAlreadyCompressed(bytes: Uint8Array): boolean {
  const format = sniffFormat(bytes);
  return format !== undefined && COMPRESSED_FORMATS.has(format.id);
}

// — SVG safety (layer one of three; the other two are serving headers) ——

const NUMERIC_ENTITY = /&#(x[0-9a-f]+|\d+);?/gi;
const SCRIPT_URL = /(?:java|vb)script:/i;
const HREF_ATTRIBUTE = /\bhref\s*=\s*(["'])\s*([^"']*)/gi;
const EMBEDDED_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp);base64,/i;
const CSS_URL = /url\(\s*(["']?)\s*([^"')]*)/gi;

const SVG_FORBIDDEN: readonly (readonly [RegExp, string])[] = [
  [/<\s*script/i, "a script element"],
  [/<\s*foreignObject/i, "a foreignObject element"],
  [/<\s*(?:iframe|embed|object)\b/i, "an embedded document"],
  [/[\s"'/]on[a-z]+\s*=/i, "an event-handler attribute"],
  [/<!ENTITY/i, "an entity declaration"],
  [/<\?xml-stylesheet/i, "an external stylesheet"],
  [/@import/i, "a CSS import"],
];

const LAST_SPACING_CODE_POINT = 0x20;

// The text with every whitespace and control character removed, so a scheme
// split by spaces, tabs or newlines (`java\tscript:`) reads as one.
function withoutSpacing(text: string): string {
  return Array.from(text)
    .filter(
      (char) =>
        (char.codePointAt(0) ?? 0) > LAST_SPACING_CODE_POINT &&
        !/\s/u.test(char),
    )
    .join("");
}

function decodeNumericEntities(text: string): string {
  return text.replace(NUMERIC_ENTITY, (_match, code: string) => {
    const point =
      code.startsWith("x") || code.startsWith("X")
        ? Number.parseInt(code.slice(1), 16)
        : Number.parseInt(code, 10);
    return Number.isNaN(point) || point > 0x10ffff
      ? ""
      : String.fromCodePoint(point);
  });
}

// What makes an SVG unsafe to store, or undefined when it is plain
// vector art: no script, no event handlers, no foreign content, and no
// reference to anything outside the file. The text is decoded as UTF-8
// strictly, so bytes that hide markup in another encoding are refused too.
export function svgProblem(bytes: Uint8Array): string | undefined {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "is not valid UTF-8 text";
  }
  const decoded = decodeNumericEntities(text);
  for (const [pattern, what] of SVG_FORBIDDEN) {
    if (pattern.test(decoded)) return `contains ${what}`;
  }
  if (SCRIPT_URL.test(withoutSpacing(decoded))) {
    return "contains a script URL";
  }
  for (const match of decoded.matchAll(HREF_ATTRIBUTE)) {
    const target = match[2] ?? "";
    if (!target.startsWith("#") && !EMBEDDED_IMAGE.test(target)) {
      return "references an external resource";
    }
  }
  for (const match of decoded.matchAll(CSS_URL)) {
    const target = match[2] ?? "";
    if (!target.startsWith("#") && !EMBEDDED_IMAGE.test(target)) {
      return "references an external resource";
    }
  }
  return undefined;
}

// — Names ————————————————————————————————————————————————————

const MAX_NAME_LENGTH = 100;
const UNSAFE_NAME_CHARS = /[^\p{L}\p{N}._-]+/gu;

// A client-supplied file name as one safe path segment: its basename, NFC,
// letters/digits/`.`/`_`/`-` only (anything else becomes `-`, so the name is
// a bare link destination that never needs escaping), no leading dot, at
// most MAX_NAME_LENGTH. `undefined` when nothing usable is left.
export function normalizeFileName(raw: string): string | undefined {
  const base = raw.replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base
    .normalize("NFC")
    .replace(UNSAFE_NAME_CHARS, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.-]+/, "");
  const dot = cleaned.lastIndexOf(".");
  const stem = dot === -1 ? cleaned : cleaned.slice(0, dot);
  const extension = dot === -1 ? "" : cleaned.slice(dot).toLowerCase();
  const trimmedStem = stem.replace(/[.-]+$/, "").slice(0, MAX_NAME_LENGTH);
  return trimmedStem === "" ? undefined : `${trimmedStem}${extension}`;
}

// The name a nameless upload (a pasted screenshot) gets: derived from the
// bytes, so pasting the same image twice is one file.
export function pastedFileName(hash: string, format: FileFormat): string {
  return `pasted-${hash.slice(0, 8)}.${format.extension}`;
}

// `name.ext` → `name-2.ext`, `name-3.ext`, … until a name not in `taken`.
export function uniqueFileName(
  wanted: string,
  taken: ReadonlySet<string>,
): string {
  if (!taken.has(wanted)) return wanted;
  const dot = wanted.lastIndexOf(".");
  const stem = dot === -1 ? wanted : wanted.slice(0, dot);
  const extension = dot === -1 ? "" : wanted.slice(dot);
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${String(n)}${extension}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// — The upload verdict ———————————————————————————————————————

export type UploadVerdict = Readonly<
  | { ok: true; format: FileFormat; name: string | undefined }
  | ({ ok: false } & FileRejection)
>;

const reject = (
  reason: FileRejectionReason,
  message: string,
): UploadVerdict => ({ ok: false, reason, message });

// Decide whether `bytes` named `rawName` may be stored. The format comes from
// the bytes; a name must carry an extension for that same format (a renamed
// `.exe` is refused, and so is a PNG called `.pdf`). A missing name is fine:
// `name` is then undefined and the caller derives one.
export function judgeUpload(
  bytes: Uint8Array,
  rawName: string | undefined,
): UploadVerdict {
  if (bytes.byteLength === 0) return reject("empty", "The file is empty.");
  if (bytes.byteLength > MAX_FILE_BYTES) {
    return reject(
      "too-large",
      `The file is larger than ${String(MAX_FILE_BYTES / (1024 * 1024))} MiB.`,
    );
  }
  const format = sniffFormat(bytes);
  if (format === undefined) {
    return reject(
      "unsupported-type",
      "Only PNG, JPEG, GIF, WebP, AVIF, SVG and PDF files can be added.",
    );
  }
  if (format.id === "svg") {
    const problem = svgProblem(bytes);
    if (problem !== undefined) {
      return reject("unsafe-svg", `This SVG ${problem}, so it was not added.`);
    }
  }
  if (rawName === undefined || rawName.trim() === "") {
    return { ok: true, format, name: undefined };
  }
  const name = normalizeFileName(rawName);
  if (name === undefined) {
    return reject("invalid-name", "The file name has no usable characters.");
  }
  const extension = name.slice(name.lastIndexOf(".") + 1);
  if (!name.includes(".") || !format.extensions.includes(extension)) {
    return reject(
      "extension-mismatch",
      `The file is a ${format.id.toUpperCase()}, but its name does not end in .${format.extension}.`,
    );
  }
  return { ok: true, format, name };
}

// — Serving ————————————————————————————————————————————————————

// A stored file as the app and the editor see it. `url` is what an `<img>`
// loads; nothing about a file's path or project appears outside it.
export type AssetRef = Readonly<{
  url: string;
  name: string;
  contentType: string;
  size: number;
}>;

// Where a stored file is served in the app: `/api/files/<project>/<hash>`.
// Only the content hash identifies it; no path appears in the URL.
export const FILES_API_PATH = "/api/files";

export function fileUrl(projectId: string, hash: string): string {
  return `${FILES_API_PATH}/${projectId}/${hash}`;
}

export function isImageContentType(contentType: string): boolean {
  return formatOfContentType(contentType)?.role === "image";
}

const SEC_FETCH_DEST_IMAGE = "image";

// RFC 6266: an ASCII fallback plus the exact UTF-8 name (a header value must
// be Latin-1, and a normalized name may carry any letter).
function contentDisposition(inline: boolean, filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// The headers a stored file is served with. Safe by construction: the type
// comes from our metadata (never R2), `nosniff` pins it, the CSP makes even
// an SVG opened as a document inert (no script, no network, sandboxed), and
// anything that is not being loaded as an `<img>` and could carry active
// content (SVG) or is download-only (PDF) is an attachment. The bytes are
// immutable and content-addressed, so by default they cache forever, but only
// privately. A route whose authorization can be withdrawn (a share link)
// passes a short `cacheControl` instead, so revocation bites quickly.
export const FILE_CACHE_IMMUTABLE = "private, max-age=31536000, immutable";
export const FILE_CACHE_SHARE_LINK = "private, max-age=300";

export function fileResponseHeaders(
  args: Readonly<{
    hash: string;
    contentType: string;
    filename: string;
    size: number;
    fetchDest: string | null;
    cacheControl?: string;
  }>,
): Headers {
  const format = formatOfContentType(args.contentType);
  const inline =
    format?.role === "image" &&
    (format.id !== "svg" || args.fetchDest === SEC_FETCH_DEST_IMAGE);
  return new Headers({
    "content-type": args.contentType,
    "content-length": String(args.size),
    "content-disposition": contentDisposition(inline, args.filename),
    "cache-control": args.cacheControl ?? FILE_CACHE_IMMUTABLE,
    etag: `"${args.hash}"`,
    vary: "Sec-Fetch-Dest",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  });
}

export const FILE_HASH_PATTERN = /^[0-9a-f]{64}$/;
