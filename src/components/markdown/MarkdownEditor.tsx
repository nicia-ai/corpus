import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import {
  HighlightStyle,
  syntaxHighlighting,
  syntaxTree,
} from "@codemirror/language";
import { type Diagnostic, linter, lintGutter } from "@codemirror/lint";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useRef } from "react";

// Source-of-truth markdown editor: CodeMirror over a plain textarea so the
// edit surface looks engineered (the design system's posture) and can carry
// inline diagnostics. The one diagnostic today: a schemeless markdown link
// whose target is not an existing document slug in this project. It warns
// (wavy underline + bubbled count) — it never blocks Save, because authoring
// a reference before its target is normal order, not an error.

// A schemeless link target resolved against the project's slugs. Returns the
// warning message when it points nowhere, otherwise undefined. External URLs
// (any scheme, protocol-relative) and in-page anchors are deliberately
// out of scope — we cannot and should not validate those.
function classifyInternalRef(
  target: string,
  known: ReadonlySet<string>,
  self: string,
): string | undefined {
  let ref = target.trim();
  if (ref === "" || ref.startsWith("#") || ref.startsWith("//"))
    return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return undefined; // http:, mailto:, …
  ref = ref.replace(/[?#].*$/, ""); // drop query / fragment
  ref = ref.replace(/^\/+/, "").replace(/^documents\//, ""); // route prefix
  ref = ref.replace(/\.md$/i, "");
  if (ref === "" || ref === self || known.has(ref)) return undefined;
  return `No document “${ref}” in this project`;
}

// Restrained highlight: single blue accent on links only (consistent with
// the rendered view), everything else weight/shade in the slate ramp.
const mdHighlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: "600", color: "#0f172a" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "#2563eb" },
  { tag: t.url, color: "#64748b" },
  { tag: t.monospace, color: "#0f172a" },
  { tag: [t.processingInstruction, t.list, t.quote], color: "#64748b" },
  { tag: t.contentSeparator, color: "#94a3b8" },
]);

const designTheme = EditorView.theme({
  "&": { backgroundColor: "#ffffff", color: "#0f172a", fontSize: "0.875rem" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6" },
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
});

type Props = Readonly<{
  value: string;
  onChange: (next: string) => void;
  docSlugs: readonly string[];
  selfSlug: string;
  onBrokenChange?: (count: number) => void;
}>;

export function MarkdownEditor({
  value,
  onChange,
  docSlugs,
  selfSlug,
  onBrokenChange,
}: Props): React.ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(null);
  // Linter inputs change with route data, not per keystroke; a compartment
  // lets us reconfigure the rule without tearing down the editor. The latest
  // callbacks live in refs so the one-time extension closures never go stale.
  const linterC = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onBrokenRef = useRef(onBrokenChange);
  useEffect(() => {
    onChangeRef.current = onChange;
    onBrokenRef.current = onBrokenChange;
  });

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
    const cm = new EditorView({
      parent,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown(),
          syntaxHighlighting(mdHighlight),
          EditorView.lineWrapping,
          lintGutter(),
          linterC.current.of(refLinter(docSlugs, selfSlug)),
          designTheme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = cm;
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
    view.current?.dispatch({
      effects: linterC.current.reconfigure(refLinter(docSlugs, selfSlug)),
    });
  }, [docSlugs, selfSlug]);

  return (
    <div
      ref={host}
      className="min-h-[28rem] overflow-hidden rounded-md border border-slate-300 bg-white focus-within:border-blue-600 focus-within:outline-2 focus-within:outline-blue-600"
    />
  );
}
