// The MarkdownEditor host's box class: full-page, borderless, on the white
// page (the document is the figure — no form-field box or blue focus ring).
//
// Deliberately its own zero-dependency module, not exported from
// MarkdownEditor.tsx itself: MarkdownEditor.tsx statically imports CodeMirror
// (@codemirror/*), so a caller that only needs this class string — e.g. a
// Suspense fallback shown BEFORE the lazy-loaded editor chunk arrives —
// must not import anything from that module, or it would pull the CodeMirror
// bundle into its own chunk and defeat the lazy-loading it exists to precede.
export const markdownEditorHostClass = "min-h-112";
