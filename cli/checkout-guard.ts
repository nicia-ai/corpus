import { sep } from "node:path";

import { CliError } from "./errors.js";

// A checkout is untrusted input: a file inside it may be a symbolic link to
// something outside (a secret, another repository), and `push --all` would
// read it and send it to Corpus. These guards keep every read and every
// candidate file inside the directory being pushed.

export type CheckoutFs = Readonly<{
  // The canonical path, or `undefined` when nothing exists there.
  realPath: (path: string) => Promise<string | undefined>;
  // True only for a regular file; a symbolic link, directory or submodule is
  // not one (`lstat`, never following links).
  isRegularFile: (path: string) => Promise<boolean>;
}>;

function isWithin(root: string, path: string): boolean {
  return (
    path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
  );
}

// Wraps a `readText` so it refuses any path whose canonical location is
// outside `root`. An absent path is still `undefined` (a dangling link reads
// as a missing file).
export function containedReadText(
  root: string,
  fs: CheckoutFs,
  readText: (path: string) => Promise<string | undefined>,
): (path: string) => Promise<string | undefined> {
  return async (path) => {
    const real = await fs.realPath(path);
    if (real === undefined) return undefined;
    const realRoot = await fs.realPath(root);
    if (realRoot === undefined || !isWithin(realRoot, real)) {
      throw new CliError(
        "unsafe-path",
        `refusing to read "${path}": it resolves outside ${root} (a symbolic link?). Nothing was changed.`,
      );
    }
    return readText(path);
  };
}

// Candidate files for a push: regular files only. Symbolic links are never
// followed, so a link to a file or folder elsewhere is never a document.
export async function regularFilesOnly(
  dir: string,
  relativePaths: readonly string[],
  fs: CheckoutFs,
  join: (dir: string, path: string) => string,
): Promise<readonly string[]> {
  const kept: string[] = [];
  for (const path of relativePaths) {
    if (await fs.isRegularFile(join(dir, path))) kept.push(path);
  }
  return kept;
}
