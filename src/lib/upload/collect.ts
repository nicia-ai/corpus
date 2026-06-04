// Browser-side upload collection: file/dir pick, dropped folders, or a
// `.zip` → flat `{ path, text }[]` (the `importDocuments` shape), with
// non-text partitioned into a `skipped` list. No server import — kept
// client-only so all File/zip work stays in the event handler.

import { strFromU8, unzipSync } from "fflate";

export type CollectedFile = Readonly<{ path: string; text: string }>;
export type SkippedFile = Readonly<{ path: string; reason: string }>;
export type Collected = Readonly<{
  files: readonly CollectedFile[];
  skipped: readonly SkippedFile[];
}>;

// True when the drop actually carried OS files (a `file`-kind item or a
// populated FileList). A drag from a code editor / app surfaces only
// `string` items (paths/URLs), which a web page can't read — the caller
// uses this to explain that instead of failing opaquely.
export function dropHasFiles(dataTransfer: DataTransfer): boolean {
  if (dataTransfer.files.length > 0) return true;
  return Array.from(dataTransfer.items).some((item) => item.kind === "file");
}

// Decision (see plan): markdown/text only. Everything else is reported,
// not imported.
const TEXT_EXT = /\.(md|markdown|mdx|txt)$/i;
const ZIP_EXT = /\.zip$/i;

// Normalize a raw path: POSIX separators, no leading `./` or `/`, no
// empty/`.`/`..` segments, drop macOS archive cruft and dotfiles.
function cleanPath(raw: string): string | null {
  const segments = raw
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s !== "" && s !== "." && s !== "..");
  if (segments.length === 0) return null;
  if (segments[0] === "__MACOSX") return null;
  const base = segments[segments.length - 1] ?? "";
  if (base.startsWith(".")) return null;
  return segments.join("/");
}

function isZipBytes(bytes: Uint8Array): boolean {
  // Local file header `PK\x03\x04` or empty-archive `PK\x05\x06`.
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05) &&
    (bytes[3] === 0x04 || bytes[3] === 0x06)
  );
}

function partition(
  path: string,
  bytes: Uint8Array,
  out: { files: CollectedFile[]; skipped: SkippedFile[] },
  zipPrefix = "",
): void {
  const label = zipPrefix ? `${zipPrefix} › ${path}` : path;
  if (ZIP_EXT.test(path) || isZipBytes(bytes)) {
    if (zipPrefix) {
      out.skipped.push({ path: label, reason: "nested zip not expanded" });
      return;
    }
    expandZip(path, bytes, out);
    return;
  }
  if (!TEXT_EXT.test(path)) {
    out.skipped.push({ path: label, reason: "unsupported file type" });
    return;
  }
  try {
    out.files.push({ path, text: strFromU8(bytes) });
  } catch {
    out.skipped.push({ path: label, reason: "could not decode as UTF-8" });
  }
}

function expandZip(
  zipName: string,
  bytes: Uint8Array,
  out: { files: CollectedFile[]; skipped: SkippedFile[] },
): void {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    out.skipped.push({ path: zipName, reason: "could not read zip archive" });
    return;
  }
  for (const [name, content] of Object.entries(entries)) {
    if (name.endsWith("/")) continue; // directory entry
    const path = cleanPath(name);
    if (path === null) continue;
    partition(path, content, out, zipName.replace(ZIP_EXT, ""));
  }
}

async function readFile(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

// A picked File carries `webkitRelativePath` when it came from a
// directory pick; otherwise just its name (a loose root-level file).
function pathOf(file: File): string | null {
  const rel = (file as File & { webkitRelativePath?: string })
    .webkitRelativePath;
  return cleanPath(rel && rel !== "" ? rel : file.name);
}

export async function collectFromFiles(
  list: readonly File[],
): Promise<Collected> {
  const out = { files: [] as CollectedFile[], skipped: [] as SkippedFile[] };
  for (const file of list) {
    const path = pathOf(file);
    if (path === null) continue;
    partition(path, await readFile(file), out);
  }
  return out;
}

// Drag-drop: each item may be a directory; walk the entry tree so a
// dropped folder behaves exactly like a directory pick.
type FsEntry = Readonly<{
  isFile: boolean;
  isDirectory: boolean;
  fullPath: string;
  file?: (cb: (f: File) => void, err: (e: unknown) => void) => void;
  createReader?: () => Readonly<{
    readEntries: (
      cb: (e: readonly FsEntry[]) => void,
      err: (e: unknown) => void,
    ) => void;
  }>;
}>;

function entryFile(entry: FsEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    // Member call (not an extracted reference) so `this` stays bound to
    // the entry — a detached DOM method throws "Illegal invocation".
    if (entry.file === undefined) reject(new Error("not a file"));
    else entry.file(resolve, reject);
  });
}

function readDir(entry: FsEntry): Promise<readonly FsEntry[]> {
  if (entry.createReader === undefined) return Promise.resolve([]);
  // Member call so `this` stays bound to the entry (see entryFile).
  const reader = entry.createReader();
  return new Promise((resolve, reject) => {
    const acc: FsEntry[] = [];
    const pump = (): void =>
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(acc);
        else {
          acc.push(...batch);
          pump();
        }
      }, reject);
    pump();
  });
}

async function walkEntry(
  entry: FsEntry,
  out: { files: CollectedFile[]; skipped: SkippedFile[] },
): Promise<void> {
  if (entry.isFile) {
    const path = cleanPath(entry.fullPath);
    if (path === null) return;
    partition(path, await readFile(await entryFile(entry)), out);
    return;
  }
  if (entry.isDirectory) {
    for (const child of await readDir(entry)) await walkEntry(child, out);
  }
}

export async function collectFromDataTransfer(
  dataTransfer: DataTransfer,
): Promise<Collected> {
  const out = { files: [] as CollectedFile[], skipped: [] as SkippedFile[] };
  const dirs: FsEntry[] = [];
  const looseFiles: File[] = [];
  // Capture entries AND files synchronously — the DataTransfer is only
  // valid during the drop event, before the first await. Folders go
  // through the entry walker (the only way to read their contents); a
  // top-level file is read via `getAsFile()` directly, which is more
  // reliable than the FileSystemFileEntry.file() callback.
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== "file") continue;
    // DOM types `webkitGetAsEntry` as FileSystemEntry; bridge it to the
    // structural FsEntry this module walks (contained DOM-typing cast).
    const entry = item.webkitGetAsEntry() as unknown as FsEntry | null;
    if (entry?.isDirectory === true) {
      dirs.push(entry);
      continue;
    }
    const file = item.getAsFile();
    if (file !== null) looseFiles.push(file);
    // Entry says file but getAsFile gave nothing — walk it instead.
    else if (entry?.isFile === true) dirs.push(entry);
  }
  // Fallback to the plain FileList when the items API gave us nothing —
  // some browsers populate `dataTransfer.files` for a loose-file drop but
  // not `items`/`webkitGetAsEntry`. A dropped folder only ever surfaces
  // through the entry API, so this won't recover folder contents.
  if (dirs.length === 0 && looseFiles.length === 0) {
    looseFiles.push(...Array.from(dataTransfer.files));
  }
  for (const dir of dirs) await walkEntry(dir, out);
  if (looseFiles.length > 0) {
    const loose = await collectFromFiles(looseFiles);
    out.files.push(...loose.files);
    out.skipped.push(...loose.skipped);
  }
  return out;
}

// The single top-level directory shared by every collected file, if
// there is exactly one — used to pre-fill the "import into folder"
// field so a zip/dir named `my-docs` lands under `my-docs`.
export function commonRoot(files: readonly CollectedFile[]): string | null {
  const tops = new Set<string>();
  for (const f of files) {
    const slash = f.path.indexOf("/");
    if (slash === -1) return null; // a loose root-level file → no single root
    tops.add(f.path.slice(0, slash));
  }
  return tops.size === 1 ? ([...tops][0] ?? null) : null;
}

// Place every collected entry at its final import path: prefix the
// destination's folder names (`[]` = project root), optionally dropping
// the upload's own common-root wrapper for a "merge into the
// destination" upload. With no parent segments and the wrapper kept,
// paths are returned unchanged — a single loose file lands at the root,
// no folder synthesized.
export function placeEntries(
  files: readonly CollectedFile[],
  parentSegments: readonly string[],
  dropWrapper: boolean,
): readonly CollectedFile[] {
  const root = dropWrapper ? commonRoot(files) : null;
  const prefix =
    parentSegments.length > 0 ? `${parentSegments.join("/")}/` : "";
  return files.map((f) => {
    const tail = root === null ? f.path : f.path.slice(root.length + 1);
    return { path: `${prefix}${tail}`, text: f.text };
  });
}
