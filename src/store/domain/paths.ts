import { slugify, slugifyToken } from "../../util";

// Pure, zero-IO path/slug domain. The folder tree is the authoring
// truth; `slug` is stable identity; `path` is DERIVED (folder ancestry
// + `filename`) and never stored. `slug` is never reverse-parsed for a
// path — these functions only ever produce slugs/paths, never decode
// them. Unit-tested without a DO (test/paths.test.ts).

// Strip a single trailing file extension from a basename
// (`setup.md` → `setup`, `a.test.ts` → `a.test`, `README` → `README`).
export function stripExtension(base: string): string {
  return base.replace(/\.[^./]+$/, "");
}

// Split a POSIX-ish relative path into ordered, non-empty segments.
// Tolerates leading `./`, repeated/leading/trailing slashes, and
// backslashes (Windows-zip uploads).
export function pathSegments(relativePath: string): string[] {
  return relativePath
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== ".");
}

// The basename of a relative path, extension included
// (`a/b/api-auth.md` → `api-auth.md`). Empty path → "".
export function basename(relativePath: string): string {
  const segs = pathSegments(relativePath);
  return segs[segs.length - 1] ?? "";
}

// The single shared top-level folder name across a batch of paths.
// `undefined` when entries are empty, any entry is at the project root,
// or entries span more than one top folder — the importer's link target
// is exactly the case where every entry lives under one folder.
export function commonRootSegment(
  entries: readonly Readonly<{ path: string }>[],
): string | undefined {
  if (entries.length === 0) return undefined;
  let shared: string | undefined;
  for (const e of entries) {
    const segs = pathSegments(e.path);
    if (segs.length < 2) return undefined;
    const top = segs[0];
    if (top === undefined) return undefined;
    if (shared === undefined) shared = top;
    else if (shared !== top) return undefined;
  }
  return shared;
}

// Default `filename` for a document created without an uploaded file
// (editor save, bundle import, seed). Keeps `path` derivation working
// for non-uploaded docs. `slug` is already a safe flat token.
export function defaultFilename(slug: string): string {
  return `${slug}.md`;
}

// Stable flat slug derived from an import path: slugify each segment,
// drop the final extension, join with `-`. Then deterministically
// suffix (`-2`, `-3`, …) until unused. Flat by construction (never
// contains `/`); collision-safe so `a/b.md`, `a-b.md`, and `a/b` get
// distinct stable slugs. Never reverse-parsed — path comes from the
// folder tree + `filename`, not from this.
export function normalizeSlug(
  relativePath: string,
  taken: ReadonlySet<string>,
): string {
  const segs = pathSegments(relativePath);
  const last = segs.length - 1;
  const base = segs
    .map((seg, i) => slugifyToken(i === last ? stripExtension(seg) : seg))
    .filter((s) => s.length > 0)
    .join("-");
  // `slugify` folds the same `doc-<stableHash>` empty fallback.
  const root = base.length > 0 ? base : slugify(relativePath);
  if (!taken.has(root)) return root;
  // Terminates by pigeonhole: a finite `taken` cannot exhaust the
  // infinite `root-2, root-3, …` sequence.
  for (let n = 2; ; n += 1) {
    const candidate = `${root}-${String(n)}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// The derived, human-facing path: ancestor folder names (root → leaf)
// then `filename`. The single definition of "a document's path"; every
// projection (web, MCP) routes through here so the rule never drifts.
export function derivePath(
  ancestorFolderNames: readonly string[],
  filename: string,
): string {
  return [...ancestorFolderNames, filename].join("/");
}

// Resolve a raw relative Markdown link target against the SOURCE
// document's current derived path, POSIX-style. Returns the project
// path the link points at, or undefined when it is not an in-project
// relative reference (a pure `#anchor`, or it escapes the project root
// via too many `..`). The fragment is stripped (anchors don't select a
// document). A leading `/` is "from the project root". Pure: resolution
// is `parsed-link ⊕ this`, computed at projection time — bytes are
// never rewritten. The caller maps the result through the path→slug
// map; an unmapped result is a dangling link (documentSlug: null).
export function resolveRelativePath(
  sourcePath: string,
  rawTarget: string,
): string | undefined {
  const hash = rawTarget.indexOf("#");
  const noFragment = hash === -1 ? rawTarget : rawTarget.slice(0, hash);
  if (noFragment === "") return undefined;
  const fromRoot = noFragment.startsWith("/");
  const stack = fromRoot ? [] : pathSegments(sourcePath).slice(0, -1);
  for (const seg of pathSegments(noFragment)) {
    if (seg === "..") {
      if (stack.length === 0) return undefined;
      stack.pop();
    } else {
      stack.push(seg);
    }
  }
  const resolved = stack.join("/");
  return resolved === "" ? undefined : resolved;
}
