// Pure, zero-IO Markdown link extraction — the content-keyed lens.
// The relative-link set of a document is a pure function of its
// immutable bytes, so it is parsed once and cached by `contentHash`
// (the DO owns that cache; this just computes). Canonical bytes are
// NEVER rewritten — resolution happens at projection time against the
// current path map (store/domain/paths.ts + the DO).
//
// CommonMark inline and reference link/image destinations only. Raw HTML
// (`<a href>`) is out — a markdown corpus has no need to traverse it, and
// supporting it would force a full HTML parser into the worker bundle.
// Only RELATIVE targets are kept; absolute URLs, scheme/protocol-relative,
// `mailto:`, and pure `#anchor` targets are dropped (they never resolve
// to a project document).

// `[text](dest)` / `![alt](dest)` — dest is either `<…>` (may contain
// spaces, CommonMark) or bare (no whitespace), with an optional
// "title" / 'title' / (title) after whitespace.
const INLINE =
  /!?\[[^\]]*\]\(\s*(?:<([^>]*)>|([^)\s]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;

// Reference definitions: `[label]: dest "optional title"` (≤3 lead spaces).
const REFERENCE = /^ {0,3}\[[^\]]+\]:\s*(?:<([^>]*)>|(\S+))/gm;

function isRelative(target: string): boolean {
  if (target === "") return false;
  // Pure in-document anchor.
  if (target.startsWith("#")) return false;
  // Protocol-relative (`//host/...`).
  if (target.startsWith("//")) return false;
  // Any URI scheme: `http:`, `https:`, `mailto:`, `data:`, `tel:`, …
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false;
  return true;
}

// Ordered, de-duplicated list of relative link targets (raw, exactly as
// written — resolution against the path map is a separate, later step).
export function parseRelativeLinks(markdown: string): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const collect = (re: RegExp): void => {
    re.lastIndex = 0;
    for (let m = re.exec(markdown); m !== null; m = re.exec(markdown)) {
      // Group 1 = `<bracketed>` destination, group 2 = bare.
      const target = m[1] ?? m[2];
      if (target !== undefined && isRelative(target) && !seen.has(target)) {
        seen.add(target);
        out.push(target);
      }
    }
  };
  collect(INLINE);
  collect(REFERENCE);
  return out;
}
