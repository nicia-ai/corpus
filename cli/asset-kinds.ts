// What a checkout may carry as an image or attachment. The server decides by
// sniffing the bytes (a renamed program is refused there); this list only
// says which untracked files `push --all` offers it, so a stray `.exe` or
// `.zip` is never read, let alone sent. This package is published standalone
// and cannot import the server tree, so the values are mirrored here;
// `test/cli-assets.test.ts` fails if they drift from `file-kinds.ts`.
export const ASSET_EXTENSIONS: readonly string[] = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "svg",
  "pdf",
];

export const MAX_ASSET_BYTES = 10 * 1024 * 1024;

export function isAssetPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return (
    dot > 0 && ASSET_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase())
  );
}
