import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  HighlightStyle,
  syntaxHighlighting,
  syntaxTree,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { type Diagnostic, linter } from "@codemirror/lint";
import { Compartment, type Extension, EditorState } from "@codemirror/state";
import {
  EditorView,
  highlightActiveLine,
  keymap,
  placeholder,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ReviewRailLayout } from "@/components/review/ReviewRail";
import { hrefToDocSlug, isExternalHref } from "@/lib/doc-href";

import { markdownEditorHostClass } from "./host-class";
import { livePreview, setReviewPopoverOpen } from "./live-preview";
import {
  liveReview,
  type ReviewMark,
  type ReviewSelection,
  setFlashRanges,
  setReviewMarks,
  type SourceRange,
} from "./live-review";
import { Markdown } from "./Markdown";

// Source-of-truth markdown editor: CodeMirror with Obsidian-style live preview
// (see ./live-preview), so the edit surface reads as the rendered document —
// headings sized, emphasis/links/lists/tasks rendered — while the markdown
// source stays the literal edit buffer (the canonical bytes versioning, block
// anchors, and agent suggestion diffs all key off; a WYSIWYG that re-serialized
// markdown on save would churn all three). It also carries inline diagnostics.
// The one diagnostic today: a schemeless markdown link whose target is not an
// existing document slug in this project. It warns (wavy underline + bubbled
// count) — it never blocks Save, because authoring a reference before its
// target is normal order, not an error.

// A schemeless link target resolved against the project's slugs. Returns the
// warning message when it points nowhere, otherwise undefined. External URLs
// (any scheme, protocol-relative) and in-page anchors are deliberately
// out of scope — we cannot and should not validate those. Reuses the shared
// href helpers (doc-href.ts) so the linter and the link-follower agree on
// what counts as external and how a slug is extracted.
function classifyInternalRef(
  target: string,
  known: ReadonlySet<string>,
  self: string,
): string | undefined {
  const ref = target.trim();
  if (ref === "" || ref.startsWith("#") || isExternalHref(ref))
    return undefined;
  const slug = hrefToDocSlug(ref);
  if (slug === "" || slug === self || known.has(slug)) return undefined;
  return `No document “${slug}” in this project`;
}

// CodeMirror contenteditable attributes (aria-label / aria-describedby) ride a
// Compartment so they can be reconfigured post-mount — the editor is built once
// in a mount effect, but `aria-describedby` wires to a validation error that
// only appears after a failed submit, so it must update without rebuilding.
function contentAttributes(
  label: string | undefined,
  describedBy: string | undefined,
): Extension {
  const attrs: Record<string, string> = {};
  if (label !== undefined) attrs["aria-label"] = label;
  if (describedBy !== undefined) attrs["aria-describedby"] = describedBy;
  return EditorView.contentAttributes.of(attrs);
}

// Restrained highlight: single blue accent on links only (consistent with
// the rendered view), everything else weight/shade in the slate ramp. Heading
// SIZES ride the heading-text token (not the line) so the live-preview marker
// reveal never reflows; the sizes are the shared --doc-h*-size tokens
// (styles.css @theme) so the editor and the rendered `.md` surface stay in sync.
const mdHighlight = HighlightStyle.define([
  {
    tag: t.heading1,
    fontSize: "var(--doc-h1-size)",
    fontWeight: "600",
    color: "#0f172a",
  },
  {
    tag: t.heading2,
    fontSize: "var(--doc-h2-size)",
    fontWeight: "600",
    color: "#0f172a",
  },
  {
    tag: t.heading3,
    fontSize: "var(--doc-h3-size)",
    fontWeight: "600",
    color: "#0f172a",
  },
  {
    tag: [t.heading4, t.heading5, t.heading6],
    fontSize: "var(--doc-hmin-size)",
    fontWeight: "600",
    color: "#0f172a",
  },
  { tag: t.heading, fontWeight: "600", color: "#0f172a" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "#2563eb" },
  { tag: t.url, color: "#64748b" },
  { tag: t.monospace, fontFamily: "var(--font-mono)", color: "#0f172a" },
  { tag: [t.processingInstruction, t.list, t.quote], color: "#64748b" },
  { tag: t.contentSeparator, color: "#94a3b8" },
]);

// Code-token palette for fenced blocks (parsed via codeLanguages). A restrained
// set tuned to read on the slate-100 code box (DESIGN.md): violet keywords,
// emerald strings, slate comments, amber literals, blue function names, cyan
// types. Operators/punctuation/variables stay the default ink so code doesn't
// turn into a circus. Separate from mdHighlight: those tags (heading/strong/…)
// never collide with these (keyword/string/…), so the two compose cleanly.
const codeHighlight = HighlightStyle.define([
  {
    tag: [
      t.keyword,
      t.controlKeyword,
      t.moduleKeyword,
      t.operatorKeyword,
      t.definitionKeyword,
    ],
    color: "#7c3aed",
  },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#047857" },
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
    color: "#64748b",
    fontStyle: "italic",
  },
  {
    tag: [t.number, t.integer, t.float, t.bool, t.atom, t.null],
    color: "#b45309",
  },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName)],
    color: "#2563eb",
  },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], color: "#0e7490" },
  { tag: t.attributeName, color: "#b45309" },
  { tag: t.attributeValue, color: "#047857" },
]);

// The live-preview surface reads as the rendered document: prose (sans) body at
// the `.md` reading size, mono reserved for code. Heading/quote/list styling is
// keyed on the cm-md-* classes the livePreview() field emits. Heading vertical
// rhythm is PADDING, not margin (CodeMirror's height model excludes margin —
// margin desyncs click geometry; see live-preview.ts).
const designTheme = EditorView.theme({
  "&": {
    backgroundColor: "#ffffff",
    color: "#0f172a",
    fontSize: "var(--doc-body-size)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-sans)",
    lineHeight: "var(--doc-body-leading)",
  },
  // Keyboard-focus indicator without a form-field box: the active line is
  // unmarked at rest, and on focus gets a tinted background + a slate-500 left
  // rail (4.76:1, clears the 3:1 non-text minimum) marking the editing locus.
  ".cm-activeLine": { background: "transparent" },
  "&.cm-focused .cm-activeLine": {
    background: "#f8fafc",
    boxShadow: "inset 2px 0 0 #64748b",
  },
  ".cm-content": { padding: "8px 0", caretColor: "#0f172a" },
  ".cm-gutters": {
    backgroundColor: "#ffffff",
    border: "none",
    color: "#94a3b8",
  },
  ".cm-cursor": { borderLeftColor: "#0f172a" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "#e2e8f0",
  },
  ".cm-lintRange-warning": {
    textDecoration: "underline wavy #b45309",
    textUnderlineOffset: "3px",
  },

  // Weight bolds non-heading-tagged inline content (links/code) on the line;
  // the heading text color comes from the sized tokens in mdHighlight.
  ".cm-md-heading": { fontWeight: "600" },
  ".cm-md-h1": {
    lineHeight: "var(--doc-h1-leading)",
    letterSpacing: "var(--doc-h1-tracking)",
    paddingTop: "0.5em",
    paddingBottom: "0.1em",
  },
  ".cm-md-h2": {
    lineHeight: "var(--doc-h2-leading)",
    letterSpacing: "var(--doc-h2-tracking)",
    paddingTop: "0.8em",
    paddingBottom: "0.1em",
  },
  ".cm-md-h3": {
    lineHeight: "var(--doc-h3-leading)",
    paddingTop: "0.6em",
    paddingBottom: "0.1em",
  },
  ".cm-md-h4, .cm-md-h5, .cm-md-h6": {
    lineHeight: "var(--doc-hmin-leading)",
    paddingTop: "0.4em",
  },
  ".cm-content > .cm-md-h1:first-child, .cm-content > .cm-md-h2:first-child": {
    paddingTop: "0",
  },

  ".cm-md-bullet": { color: "#64748b" },
  ".cm-md-link": {
    color: "#2563eb",
    textDecoration: "underline",
    textUnderlineOffset: "2px",
  },
  ".cm-md-code": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.875em",
    background: "#f1f5f9",
    borderRadius: "4px",
    padding: "2px 4px",
  },
  ".cm-md-task-box": {
    display: "inline-flex",
    alignItems: "center",
    marginRight: "0.4em",
  },
  ".cm-md-task-box input": {
    width: "1em",
    height: "1em",
    margin: "0",
    accentColor: "#2563eb",
    cursor: "pointer",
  },
  ".cm-md-task-done": { color: "#94a3b8", textDecoration: "line-through" },
  ".cm-md-quote": {
    borderLeft: "2px solid #cbd5e1",
    paddingLeft: "16px",
    color: "#64748b",
  },
  // Slate-100 fill + left rail so a fenced block reads on the white document
  // ground (matches inline code and the rendered `.md pre`).
  ".cm-md-code-block": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.875em",
    background: "#f1f5f9",
    borderLeft: "2px solid #e2e8f0",
  },
  // GFM tables stay raw source but in mono so the `|` columns line up (the
  // proportional body font renders them ragged otherwise).
  ".cm-md-table": { fontFamily: "var(--font-mono)", fontSize: "0.875em" },
  ".cm-md-hr": { paddingTop: "0.4em", paddingBottom: "0.4em" },
  ".cm-md-rule": {
    display: "inline-block",
    width: "100%",
    borderTop: "1px solid #e2e8f0",
    verticalAlign: "middle",
  },

  // Review marks: comment amber, suggestion replace green, delete rose
  // strike-through, insert a small "+" badge at the seam (zero-width, no
  // span to wash). The palette is defined here in designTheme (the old
  // ::highlight(corpus-*) rules in lib/highlight.ts were removed when the
  // editor became the review surface). Comment and replace share a similar
  // wash lightness, so each also gets its own underline STYLE (dotted vs.
  // solid) — a hue-independent cue (AGENTS.md: "Review states must not rely
  // on hue alone").
  ".cm-md-comment": {
    backgroundColor: "#fef3c7",
    textDecoration: "underline",
    textDecorationStyle: "dotted",
    textDecorationColor: "#b45309",
    textUnderlineOffset: "2px",
  },
  ".cm-md-suggest-replace": {
    backgroundColor: "#dcfce7",
    textDecoration: "underline",
    textDecorationStyle: "solid",
    textDecorationColor: "#15803d",
    textUnderlineOffset: "2px",
  },
  ".cm-md-suggest-delete": {
    backgroundColor: "#ffe4e6",
    color: "#9f1239",
    textDecoration: "line-through",
  },
  ".cm-md-suggest-insert": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "1.1em",
    height: "1.1em",
    marginInline: "1px",
    borderRadius: "3px",
    backgroundColor: "#bbf7d0",
    color: "#166534",
    fontWeight: "700",
    fontSize: "0.75em",
    lineHeight: "1",
    verticalAlign: "middle",
    cursor: "default",
  },
  // Transient remote-change cue: a fading amber line background (background-only
  // keyframe in styles.css, so the text never fades with it).
  ".cm-md-flash": {
    animation: "corpus-line-flash 5.5s ease-out forwards",
  },
});

// Boxed usages (the create form) bound the height and scroll internally so they
// don't push surrounding page controls below the fold; the full-page document
// surface (`fill`) omits this and grows with content (the page scrolls).
const boundedHeight = EditorView.theme({
  "&": { maxHeight: "60vh" },
  ".cm-scroller": { overflow: "auto" },
});

const NO_SLUGS: readonly string[] = [];

type Props = Readonly<{
  value: string;
  // Editing props (omit for a read-only view): onChange fires on edits;
  // docSlugs/selfSlug feed the broken-link linter.
  onChange?: (next: string) => void;
  docSlugs?: readonly string[];
  selfSlug?: string;
  // Render the document but disable editing (history / read views). Skips the
  // linter, save keymap, active-line cue, and (when set) the review layer — the
  // live-preview render + code highlighting are identical to the editor.
  readOnly?: boolean;
  onBrokenChange?: (count: number) => void;
  // Accessible name for the editing region (CodeMirror renders a label-less
  // contenteditable; a visible caption is not programmatically associated).
  ariaLabel?: string;
  // ID of an element that describes the editor (e.g. a validation error).
  ariaDescribedBy?: string | undefined;
  // Full-page document surface: a bare full-width host that grows with content
  // (the page scrolls), vs the default bordered, height-bounded box.
  fill?: boolean;
  // Cmd/Ctrl-click on a rendered link; receives the raw href.
  onFollowLink?: (href: string) => void;
  // Cmd/Ctrl-S in the editor.
  onSave?: () => void;
  // Inline review: paint comment/suggestion ranges, surface a selection popover,
  // and report the rail layout. Off for the create form (plain editing only).
  review?: boolean;
  reviewMarks?: readonly ReviewMark[];
  // Source ranges to flash as a transient remote-change cue.
  flashRanges?: readonly SourceRange[];
  onReviewLayoutChange?: (layout: ReviewRailLayout) => void;
  // The Comment/Suggest popover content for the current selection, rendered by
  // the host (it owns the server actions); positioned over the selection here.
  renderReviewPopover?: (
    args: Readonly<{ from: number; to: number; dismiss: () => void }>,
  ) => React.ReactNode;
}>;

export function MarkdownEditor({
  value,
  onChange,
  docSlugs = NO_SLUGS,
  selfSlug = "",
  readOnly,
  onBrokenChange,
  ariaLabel,
  ariaDescribedBy,
  fill,
  onFollowLink,
  onSave,
  review,
  reviewMarks,
  flashRanges,
  onReviewLayoutChange,
  renderReviewPopover,
}: Props): React.ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(null);
  // The active selection drives the inline Comment/Suggest popover (review mode).
  const [reviewSelection, setReviewSelection] = useState<ReviewSelection>();
  // CodeMirror mounts client-side in the effect below; until it does (incl.
  // SSR), render the rendered Markdown so first paint shows the document rather
  // than an empty box, then swap to the live editor.
  const [mounted, setMounted] = useState(false);
  // Linter inputs change with route data, not per keystroke; a compartment
  // lets us reconfigure the rule without tearing down the editor. The latest
  // callbacks live in refs so the one-time extension closures never go stale.
  const linterC = useRef(new Compartment());
  const contentAttrsC = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onBrokenRef = useRef(onBrokenChange);
  const onFollowLinkRef = useRef(onFollowLink);
  const onSaveRef = useRef(onSave);
  const onReviewLayoutRef = useRef(onReviewLayoutChange);
  useEffect(() => {
    onChangeRef.current = onChange;
    onBrokenRef.current = onBrokenChange;
    onFollowLinkRef.current = onFollowLink;
    onSaveRef.current = onSave;
    onReviewLayoutRef.current = onReviewLayoutChange;
  });

  // Close the popover after a review action (or cancel). The text selection is
  // left as-is; the next selection gesture re-evaluates it.
  const dismissReview = useCallback((): void => {
    setReviewSelection(undefined);
  }, []);

  function refLinter(slugs: readonly string[], self: string) {
    const known = new Set(slugs);
    return linter(
      (v) => {
        const diags: Diagnostic[] = [];
        syntaxTree(v.state).iterate({
          enter: (node) => {
            if (node.name !== "URL" || node.node.parent?.name !== "Link") {
              return;
            }
            const message = classifyInternalRef(
              v.state.sliceDoc(node.from, node.to),
              known,
              self,
            );
            if (message !== undefined) {
              diags.push({
                from: node.from,
                to: node.to,
                severity: "warning",
                message,
              });
            }
          },
        });
        onBrokenRef.current?.(diags.length);
        return diags;
      },
      { delay: 350 },
    );
  }

  // Mount once (DOM widget lifecycle — not data loading). CodeMirror touches
  // the DOM, so it constructs only client-side, inside the effect.
  useEffect(() => {
    const parent = host.current;
    if (parent === null) return;
    // A read-only view (history) renders the document but disables editing;
    // the live-preview render is shared with the editor, so the two surfaces
    // match — EXCEPT code-token syntax highlighting, which DESIGN.md scopes
    // to the editing surface only ("the rendered read view and version
    // history are NOT highlighted"), so codeHighlight is gated below.
    const editing = readOnly !== true;
    const cm = new EditorView({
      parent,
      state: EditorState.create({
        doc: value,
        extensions: [
          ...(editing ? [history()] : []),
          // Save binding first so it wins over any default Mod-s mapping.
          keymap.of([
            ...(editing
              ? [
                  {
                    key: "Mod-s",
                    preventDefault: true,
                    run: () => {
                      onSaveRef.current?.();
                      return true;
                    },
                  },
                ]
              : []),
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          // GFM base + nested language parsing for fenced code, so a ```ts
          // block highlights per its language (codeLanguages lazy-loads the
          // grammar; codeHighlight colors the tokens — editing-only, below).
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          syntaxHighlighting(mdHighlight),
          livePreview(),
          EditorView.lineWrapping,
          // Editing-only: keyboard-focus locus (active line is styled only when
          // focused — see designTheme), placeholder, the broken-link linter, and
          // code-token syntax highlighting (DESIGN.md: read view/history stay
          // plain — the editor is the live surface). No lintGutter(): the empty
          // gutter is a code-IDE artifact on a prose surface; broken links warn
          // inline (wavy underline + count).
          ...(editing
            ? [
                highlightActiveLine(),
                placeholder("Start writing… markdown renders as you type"),
                linterC.current.of(refLinter(docSlugs, selfSlug)),
                syntaxHighlighting(codeHighlight),
              ]
            : []),
          // Read-only: a plain click follows a rendered link (nothing to edit).
          // Editing: require Cmd/Ctrl so a plain click can place the caret.
          EditorView.domEventHandlers({
            mousedown: (event) => {
              if (editing && !event.metaKey && !event.ctrlKey) return false;
              const el =
                event.target instanceof HTMLElement
                  ? event.target.closest("[data-href]")
                  : null;
              const href = el?.getAttribute("data-href") ?? null;
              if (href === null) return false;
              event.preventDefault();
              onFollowLinkRef.current?.(href);
              return true;
            },
          }),
          // Always mount the compartment, even when both props start
          // undefined (an empty attrs object then) — reconfiguring a
          // compartment that was never part of the base config is a silent
          // no-op in @codemirror/state, which would strand a later
          // `ariaDescribedBy` (e.g. a validation error that only appears
          // after a failed submit) with no way to reach the DOM.
          contentAttrsC.current.of(
            contentAttributes(ariaLabel, ariaDescribedBy),
          ),
          ...(review === true
            ? [
                liveReview({
                  onSelect: setReviewSelection,
                  onLayout: (layout) => onReviewLayoutRef.current?.(layout),
                }),
              ]
            : []),
          ...(fill === true ? [] : [boundedHeight]),
          ...(editing
            ? [
                EditorView.updateListener.of((u) => {
                  if (u.docChanged)
                    onChangeRef.current?.(u.state.doc.toString());
                }),
              ]
            : [EditorState.readOnly.of(true), EditorView.editable.of(false)]),
          designTheme,
        ],
      }),
    });
    view.current = cm;
    setMounted(true);
    return () => {
      cm.destroy();
    };
    // Construct once; value/slug syncing is handled by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External value changes (conflict resolution rewrites the draft) — sync
  // without clobbering the user's cursor when it already matches.
  useEffect(() => {
    const cm = view.current;
    if (cm && value !== cm.state.doc.toString()) {
      cm.dispatch({
        changes: { from: 0, to: cm.state.doc.length, insert: value },
      });
    }
  }, [value]);

  useEffect(() => {
    if (readOnly === true) return;
    view.current?.dispatch({
      effects: linterC.current.reconfigure(refLinter(docSlugs, selfSlug)),
    });
  }, [readOnly, docSlugs, selfSlug]);

  // Post-mount re-apply (e.g. a validation error id appears after a failed
  // submit). No-op until the view exists; the mount effect seeds the initial
  // value.
  useEffect(() => {
    const cm = view.current;
    if (cm === null) return;
    cm.dispatch({
      effects: contentAttrsC.current.reconfigure(
        contentAttributes(ariaLabel, ariaDescribedBy),
      ),
    });
  }, [ariaLabel, ariaDescribedBy]);

  // Push review marks (comment + suggestion source ranges) into the editor when
  // the loader data changes; no-op when review is off.
  useEffect(() => {
    if (review !== true) return;
    view.current?.dispatch({ effects: setReviewMarks.of(reviewMarks ?? []) });
  }, [review, reviewMarks]);

  // Flash the changed lines on a remote change; cleared when the cue elapses.
  useEffect(() => {
    if (review !== true) return;
    view.current?.dispatch({ effects: setFlashRanges.of(flashRanges ?? []) });
  }, [review, flashRanges]);

  // The composer's own controls take DOM focus when the popover opens for
  // editing (autoFocus), blurring the editor. Tell the live-preview reveal
  // gate the popover is open for this selection so it doesn't re-hide the
  // markup under the text the popover is annotating (see live-preview.ts).
  const popoverOpen =
    review === true &&
    reviewSelection !== undefined &&
    renderReviewPopover !== undefined;
  useEffect(() => {
    if (review !== true) return;
    view.current?.dispatch({ effects: setReviewPopoverOpen.of(popoverOpen) });
  }, [review, popoverOpen]);

  // Shared with the pre-mount fallback below (bare Markdown wrapped in the
  // same box) so first paint → live editor never jumps size, and with any
  // lazy-loading caller's own Suspense fallback (see host-class.ts) so that
  // placeholder can't drift out of sync with the mounted editor either.
  const hostClassName = markdownEditorHostClass(fill === true);

  return (
    <div className="relative">
      <div
        ref={host}
        style={{ display: mounted ? undefined : "none" }}
        className={hostClassName}
      />
      {!mounted && (
        <div className={hostClassName}>
          <Markdown source={value} bare />
        </div>
      )}
      {review === true &&
        reviewSelection !== undefined &&
        renderReviewPopover !== undefined && (
          <div
            // Key by the selection so a new selection remounts the composer with
            // fresh state instead of carrying over a stale draft/mode.
            key={`${reviewSelection.from}:${reviewSelection.to}`}
            className="absolute z-20 max-w-[calc(100vw-2rem)]"
            style={{ top: reviewSelection.top + 6, left: reviewSelection.left }}
          >
            {renderReviewPopover({
              from: reviewSelection.from,
              to: reviewSelection.to,
              dismiss: dismissReview,
            })}
          </div>
        )}
    </div>
  );
}
