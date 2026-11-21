import {
  ALLOWED_FILE_EXTENSIONS,
  formatOfExtension,
  isImageContentType,
  type AssetRef,
} from "@/store/domain/file-kinds";

// The editor's side of adding a file, pure: which dropped or pasted files are
// worth sending, what name to send, and what markdown a stored file becomes.
// This is a convenience filter, not a gate. The server sniffs the bytes and
// decides; a client that sends something else is simply refused there.

// The file picker's `accept`: every extension a stored file may carry.
export const FILE_PICKER_ACCEPT = ALLOWED_FILE_EXTENSIONS.map(
  (extension) => `.${extension}`,
).join(",");

export const UNSUPPORTED_PICK_MESSAGE =
  "Choose a PNG, JPEG, GIF, WebP, AVIF, SVG or PDF file.";

const PASTED_PLACEHOLDER_NAME = /^image\.(?:png|jpe?g|gif|webp|avif)$/i;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1);
}

function isUploadable(file: File): boolean {
  return (
    isImageContentType(file.type) ||
    file.type === "application/pdf" ||
    formatOfExtension(extensionOf(file.name)) !== undefined
  );
}

export function uploadableFiles(
  list: ArrayLike<File> | null | undefined,
): readonly File[] {
  return Array.from(list ?? []).filter(isUploadable);
}

// The name to send, or undefined to let the server name it from the bytes. A
// screenshot pasted from the clipboard arrives called `image.png` whatever it
// is, which would collide with the next one; that name says nothing.
export function nameForUpload(file: File, pasted: boolean): string | undefined {
  return pasted && PASTED_PLACEHOLDER_NAME.test(file.name)
    ? undefined
    : file.name;
}

// The relative target a stored file is linked by: next to the page, so
// `./name`. The stored name is already a bare segment (no escaping needed).
export function linkTargetFor(asset: AssetRef): string {
  return `./${asset.name}`;
}

function stem(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? name : name.slice(0, dot);
}

// What goes into the document: an image is `![alt](./name.png)` (alt from the
// file name, for the author to refine), anything else a plain link.
export function insertionMarkdown(asset: AssetRef): string {
  const target = linkTargetFor(asset);
  return isImageContentType(asset.contentType)
    ? `![${stem(asset.name)}](${target})`
    : `[${asset.name}](${target})`;
}
