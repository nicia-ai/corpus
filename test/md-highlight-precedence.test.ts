import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { highlightTree } from "@lezer/highlight";
import { describe, expect, it } from "vitest";

import { mdHighlight } from "@/components/markdown/MarkdownEditor";

// mdHighlight relies on a documented but easy-to-forget CodeMirror contract:
// HighlightStyle.define([...]) emits one CSS rule per spec, IN ARRAY ORDER,
// and gives LATER rules higher cascade precedence when a node ends up with
// multiple tag-classes (its own tag plus ones inherited from an ancestor —
// @lezer/markdown tags "Blockquote/..." and "OrderedList/... BulletList/..."
// in Inherit mode, so quote/list both bleed onto every descendant token).
// Getting the array order wrong is exactly what silently regressed the color
// of list body text and, separately, links/headings/code nested in a
// blockquote (see the comments on mdHighlight itself). This test resolves
// actual computed colors the same way the browser cascade would — by reading
// mdHighlight's own generated stylesheet, in its own emitted order — so a
// future reordering that reintroduces either bug fails here instead of only
// being visible by eye in the editor.

function colorRulesInCascadeOrder(): ReadonlyMap<string, string> {
  const rules = mdHighlight.module?.getRules() ?? "";
  const map = new Map<string, string>();
  for (const m of rules.matchAll(/\.(\S+)\s*\{[^}]*?color:\s*([^;]+);/g)) {
    const [, cls, color] = m;
    if (cls !== undefined && color !== undefined) map.set(cls, color);
  }
  return map;
}

// The color that wins for a span carrying `classes` (a space-separated list,
// as reported by highlightTree): the LAST color rule in cascade order whose
// class is present — mirroring how two equal-specificity CSS rules resolve
// when both apply to the same element. `undefined` when nothing colors it
// (the token falls back to the editor's default ink).
function resolvedColor(
  classes: string,
  rulesInOrder: ReadonlyMap<string, string>,
): string | undefined {
  const present = new Set(classes.split(" "));
  let winner: string | undefined;
  for (const [cls, color] of rulesInOrder) {
    if (present.has(cls)) winner = color;
  }
  return winner;
}

// Every (from, to, classes) span highlightTree reports for `doc`, in
// document order. A token with no matching tag at all gets no span (see the
// list-item assertion below), matching the real editor's behavior.
function highlightSpans(
  doc: string,
): readonly { from: number; to: number; classes: string }[] {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
  });
  const spans: { from: number; to: number; classes: string }[] = [];
  highlightTree(syntaxTree(state), mdHighlight, (from, to, classes) => {
    spans.push({ from, to, classes });
  });
  return spans;
}

function colorAt(doc: string, at: number): string | undefined {
  const rulesInOrder = colorRulesInCascadeOrder();
  const span = highlightSpans(doc).find((s) => at >= s.from && at < s.to);
  return span === undefined
    ? undefined
    : resolvedColor(span.classes, rulesInOrder);
}

describe("mdHighlight color precedence", () => {
  it("colors a link inside a blockquote blue, not quote gray", () => {
    const doc = "> [text](http://example.com)\n";
    const labelAt = doc.indexOf("text");
    expect(colorAt(doc, labelAt)).toBe("#2563eb");
  });

  it("colors plain quoted prose gray (the rule the link case must still respect)", () => {
    const doc = "> plain quote text\n";
    const proseAt = doc.indexOf("plain");
    expect(colorAt(doc, proseAt)).toBe("#64748b");
  });

  it("leaves list item body text uncolored (falls back to primary ink), not list gray", () => {
    const doc = "- plain item text\n";
    const bodyAt = doc.indexOf("plain");
    expect(colorAt(doc, bodyAt)).toBeUndefined();
  });
});
