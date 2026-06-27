// The MarkdownEditor host's box sizing — full-page (fill): borderless, on
// the white page (the document is the figure, no form-field box or blue
// focus ring). Boxed (create form): the bordered card with a focus ring.
//
// Deliberately its own zero-dependency module, not exported from
// MarkdownEditor.tsx itself: MarkdownEditor.tsx statically imports CodeMirror
// (@codemirror/*), so a caller that only needs this class string — e.g. a
// Suspense fallback shown BEFORE the lazy-loaded editor chunk arrives —
// must not import anything from that module, or it would pull the CodeMirror
// bundle into its own chunk and defeat the lazy-loading it exists to precede.
export function markdownEditorHostClass(fill: boolean): string {
  return fill
    ? "min-h-112"
    : "min-h-112 overflow-hidden rounded-md border border-slate-300 bg-white focus-within:border-blue-600 focus-within:outline-2 focus-within:outline-blue-600";
}
