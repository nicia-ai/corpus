// Shared resolution for a markdown link's href → an in-project document slug,
// used by both the link-follower (use-follow-doc-link) and the editor's
// broken-link linter (classifyInternalRef in MarkdownEditor).

// An external target — any URL scheme (http:, mailto:, …) or protocol-relative
// (`//host`). These open in a new tab rather than routing within the project.
export function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
}

const SAFE_EXTERNAL_SCHEME = /^(https?|mailto|tel):/i;

// A subset of isExternalHref that's actually safe to hand to window.open.
// isExternalHref only decides "not an in-project doc link" (so a
// `javascript:`/`data:`/`vbscript:` target correctly skips the slug
// resolution below), but a document is teammate- or agent-authored markdown,
// not trusted code — an active scheme must never reach window.open.
export function isSafeExternalHref(href: string): boolean {
  return SAFE_EXTERNAL_SCHEME.test(href) || href.startsWith("//");
}

// A schemeless target resolved to a bare document slug: drop any query/fragment,
// leading slashes, a `documents/` route prefix, and a `.md` suffix. Returns ""
// for a target that resolves to nothing (e.g. a pure `#anchor`).
export function hrefToDocSlug(href: string): string {
  return href
    .replace(/[?#].*$/, "")
    .replace(/^\/+/, "")
    .replace(/^documents\//, "")
    .replace(/\.md$/i, "");
}
