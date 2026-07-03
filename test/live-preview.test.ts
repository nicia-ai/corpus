import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { Decoration, DecorationSet } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import {
  livePreview,
  livePreviewField,
  setEditorFocused,
  setReviewPopoverOpen,
  toggleTaskMarker,
} from "@/components/markdown/live-preview";

// Live-preview decorations are computed from the markdown syntax tree against
// the selection (the reveal gate). We build a real EditorState with the same
// extensions the editor uses, then inspect the decoration set directly — no DOM
// is touched (widgets only render on a live view).

type DecoSpec = Readonly<{
  mdHide?: boolean;
  class?: string;
  widget?: unknown;
  attributes?: Readonly<Record<string, string>>;
}>;

const specOf = (d: Decoration): DecoSpec => d.spec as DecoSpec;

type Entry = Readonly<{ from: number; to: number; deco: Decoration }>;

function entries(set: DecorationSet): Entry[] {
  const out: Entry[] = [];
  const it = set.iter();
  while (it.value) {
    out.push({ from: it.from, to: it.to, deco: it.value });
    it.next();
  }
  return out;
}

// Build the decoration set for `doc` with the caret at [anchor, head]. The
// editor reveals raw markers only while focused, so default to focused (the
// editing case the reveal tests exercise); pass focused=false to model a
// freshly-opened, not-yet-clicked editor. `popoverOpen` simulates the review
// popover holding DOM focus while the editor itself is blurred.
function preview(
  doc: string,
  anchor = 0,
  head = anchor,
  focused = true,
  popoverOpen = false,
): Entry[] {
  const selection = EditorSelection.single(anchor, head);
  const base = EditorState.create({
    doc,
    selection,
    extensions: [markdown({ base: markdownLanguage }), livePreview()],
  });
  // One forced update so the field reflects the fully parsed tree (the
  // create-time parse budget may stop short) and the simulated focus state.
  const state = base.update({
    selection,
    effects: [
      ...(focused ? [setEditorFocused.of(true)] : []),
      ...(popoverOpen ? [setReviewPopoverOpen.of(true)] : []),
    ],
  }).state;
  return entries(state.field(livePreviewField));
}

const hidden = (es: Entry[]): { from: number; to: number }[] =>
  es
    .filter((e) => specOf(e.deco).mdHide === true)
    .map(({ from, to }) => ({ from, to }));

const hasClass = (e: Entry, cls: string): boolean => {
  const c = specOf(e.deco).class;
  return typeof c === "string" && c.split(" ").includes(cls);
};

const withClass = (es: Entry[], cls: string): Entry[] =>
  es.filter((e) => hasClass(e, cls));

const widgets = (es: Entry[]): Entry[] =>
  es.filter((e) => specOf(e.deco).widget != null);

describe("live preview: headings", () => {
  it("hides the # marker and styles the line when the caret is elsewhere", () => {
    const es = preview("# Title\n\nbody", 9);
    expect(hidden(es)).toContainEqual({ from: 0, to: 2 });
    const h1 = withClass(es, "cm-md-h1");
    expect(h1).toHaveLength(1);
    expect(h1[0]?.from).toBe(0);
  });

  it("reveals the marker when the caret is on the heading line", () => {
    const es = preview("# Title\n\nbody", 3);
    expect(hidden(es)).toHaveLength(0);
    // The line class stays present in both states so reveal never reflows.
    expect(withClass(es, "cm-md-h1")).toHaveLength(1);
  });

  it("styles all six heading levels", () => {
    const es = preview("# a\n\n## b\n\n### c\n\n#### d\n\n##### e\n\n###### f");
    for (let level = 1; level <= 6; level++)
      expect(withClass(es, `cm-md-h${level}`)).toHaveLength(1);
  });

  it("hides whitespace after the # marker (multiple spaces)", () => {
    // `#   Title` — one HeaderMark for `#`; all following spaces are hidden.
    const es = preview("#   Title\n\nbody", 12);
    expect(hidden(es)).toContainEqual({ from: 0, to: 4 });
  });

  it("styles only the text line of a Setext heading and hides the underline", () => {
    // `Title\n===` — the SetextHeading node spans both lines; only the text
    // line is sized as a heading, and the `===` underline is hidden.
    const es = preview("Title\n===\n\nbody", 11);
    const h1 = withClass(es, "cm-md-h1");
    expect(h1).toHaveLength(1);
    expect(h1[0]?.from).toBe(0); // the text line, not the underline (pos 6)
    expect(hidden(es)).toContainEqual({ from: 6, to: 9 });
  });
});

describe("live preview: inline formatting", () => {
  it("hides bold delimiters away from the selection", () => {
    const es = preview("intro\n\n**bold** here", 0);
    expect(hidden(es)).toContainEqual({ from: 7, to: 9 });
    expect(hidden(es)).toContainEqual({ from: 13, to: 15 });
  });

  it("reveals bold delimiters when a range overlaps the node", () => {
    const es = preview("intro\n\n**bold** here", 8, 18);
    const inNode = hidden(es).filter((r) => r.from >= 7 && r.to <= 15);
    expect(inNode).toHaveLength(0);
  });

  it("hides italic and strikethrough marks", () => {
    const es = preview("a *it* and ~~gone~~ b", 0);
    expect(hidden(es)).toContainEqual({ from: 2, to: 3 });
    expect(hidden(es)).toContainEqual({ from: 5, to: 6 });
    expect(hidden(es)).toContainEqual({ from: 11, to: 13 });
    expect(hidden(es)).toContainEqual({ from: 17, to: 19 });
  });

  it("hides inline-code backticks and styles the code span", () => {
    const es = preview("a `code` b", 0);
    expect(hidden(es)).toContainEqual({ from: 2, to: 3 });
    expect(hidden(es)).toContainEqual({ from: 7, to: 8 });
    const code = withClass(es, "cm-md-code");
    expect(code).toHaveLength(1);
    expect(code[0]).toMatchObject({ from: 2, to: 8 });
  });
});

describe("live preview: links", () => {
  it("renders the label and hides the brackets/url away from the caret", () => {
    const es = preview("[t](u)\n\nx", 8);
    expect(hidden(es)).toContainEqual({ from: 0, to: 1 });
    expect(hidden(es)).toContainEqual({ from: 2, to: 6 });
    const link = withClass(es, "cm-md-link");
    expect(link).toHaveLength(1);
    expect(link[0]).toMatchObject({ from: 1, to: 2 });
  });

  it("reveals full link syntax when the caret is inside", () => {
    const es = preview("[t](u)\n\nx", 1);
    expect(hidden(es)).toHaveLength(0);
  });

  it("stashes the link href for cmd-click", () => {
    const es = preview("[t](http://x)\n\nbody", 18);
    const link = withClass(es, "cm-md-link");
    expect(link).toHaveLength(1);
    const href = link[0]
      ? specOf(link[0].deco).attributes?.["data-href"]
      : undefined;
    expect(href).toBe("http://x");
  });
});

describe("live preview: block widgets", () => {
  it("renders an image as a widget away from the caret", () => {
    const es = preview("intro\n\n![cat](http://x/c.png)", 0);
    expect(widgets(es).some((e) => e.from >= 7)).toBe(true);
  });

  it("extracts alt text with nested brackets from the AST, not a regex", () => {
    // `![a [b] c](url)` — a `[^\]]*` regex stops at the first `]` (giving
    // "a [b"), but the parser knows the real closing `]` so alt is "a [b] c".
    const es = preview("intro\n\n![a [b] c](http://x/c.png)", 0);
    const w = widgets(es).find((e) => e.from >= 7);
    const widget = w ? (specOf(w.deco).widget as { alt: string }) : undefined;
    expect(widget?.alt).toBe("a [b] c");
  });

  it("shows raw image source when the caret is on its line", () => {
    const es = preview("intro\n\n![cat](http://x/c.png)", 9);
    expect(widgets(es).filter((e) => e.from >= 7)).toHaveLength(0);
  });

  it("renders frontmatter as a panel widget away from the caret", () => {
    const es = preview("---\ntitle: Hi\n---\n\nbody", 20);
    expect(widgets(es).some((e) => e.from === 0)).toBe(true);
  });

  it("shows raw YAML when the caret is in the frontmatter", () => {
    const es = preview("---\ntitle: Hi\n---\n\nbody", 5);
    expect(widgets(es).filter((e) => e.from === 0)).toHaveLength(0);
  });
});

describe("live preview: lists and tasks", () => {
  it("swaps a bullet marker for a glyph widget away from the caret", () => {
    const es = preview("text\n\n- a", 0);
    const w = widgets(es).filter((e) => e.from === 6 && e.to === 7);
    expect(w).toHaveLength(1);
  });

  it("leaves an ordered-list marker untouched", () => {
    const es = preview("text\n\n1. a", 0);
    expect(widgets(es)).toHaveLength(0);
    expect(hidden(es)).toHaveLength(0);
  });

  it("renders a checkbox and hides the dash for a task item", () => {
    const es = preview("text\n\n- [ ] todo", 0);
    expect(hidden(es)).toContainEqual({ from: 6, to: 8 });
    expect(widgets(es)).toHaveLength(1);
  });

  it("strikes a completed task", () => {
    const es = preview("text\n\n- [x] done", 0);
    expect(withClass(es, "cm-md-task-done").length).toBeGreaterThanOrEqual(1);
  });
});

describe("live preview: blocks", () => {
  it("styles a blockquote line and hides the marker away from the caret", () => {
    const es = preview("> quote\n\nx", 9);
    expect(withClass(es, "cm-md-quote")).toHaveLength(1);
    expect(hidden(es)).toContainEqual({ from: 0, to: 2 });
  });

  it("renders a horizontal rule as a widget away from the caret", () => {
    const es = preview("text\n\n---", 0);
    expect(withClass(es, "cm-md-hr")).toHaveLength(1);
    expect(widgets(es).some((e) => e.from === 6 && e.to === 9)).toBe(true);
  });

  it("renders a GFM table as a widget away from the caret", () => {
    const es = preview("intro\n\n| a | b |\n| - | - |\n| 1 | 2 |", 0);
    expect(widgets(es).some((e) => e.from >= 7)).toBe(true);
    expect(withClass(es, "cm-md-table")).toHaveLength(0);
  });

  it("shows raw mono table source when the caret is on a table line", () => {
    const es = preview("intro\n\n| a | b |\n| - | - |\n| 1 | 2 |", 9);
    expect(withClass(es, "cm-md-table").length).toBeGreaterThanOrEqual(1);
  });
});

describe("live preview: reveal gate", () => {
  it("does not reveal markers while the editor is unfocused", () => {
    // Caret on the heading line, but unfocused (a freshly-opened document):
    // the `# ` marker stays hidden — no raw markdown on open.
    const es = preview("# Title\n\nbody", 3, 3, false);
    expect(hidden(es)).toContainEqual({ from: 0, to: 2 });
    expect(withClass(es, "cm-md-h1")).toHaveLength(1);
  });

  it("reveals markers on the caret line once focused", () => {
    const es = preview("# Title\n\nbody", 3, 3, true);
    expect(hidden(es)).toHaveLength(0);
  });

  it("keeps revealing the touched markup once the editor blurs to the review popover", () => {
    // Select "important" inside the emphasis so the marker sits on the
    // selection, then simulate the popover taking focus (editor blurred, but
    // the popover is open for this selection) — the reveal must survive that
    // hand-off instead of re-hiding under the still-open popover.
    const doc = "This is **important** text.";
    const from = doc.indexOf("important");
    const to = from + "important".length;
    const stillFocused = preview(doc, from, to, true, false);
    const blurredWithPopover = preview(doc, from, to, false, true);
    expect(hidden(blurredWithPopover)).toEqual(hidden(stillFocused));
    expect(hidden(blurredWithPopover)).toHaveLength(0);
  });

  it("re-hides markup once the editor blurs and no popover is open", () => {
    const doc = "This is **important** text.";
    const from = doc.indexOf("important");
    const to = from + "important".length;
    expect(hidden(preview(doc, from, to, false, false)).length).toBeGreaterThan(
      0,
    );
  });
});

describe("fenced code", () => {
  // 0:p..3:a 4:\n 5:\n 6:```js 11:\n 12:const x = 1; 24:\n 25:``` 28:\n
  const doc = "para\n\n```js\nconst x = 1;\n```\n";

  it("hides both fence lines when the caret is outside the block", () => {
    expect(hidden(preview(doc, 0))).toEqual([
      { from: 6, to: 12 }, // ```js\n
      { from: 24, to: 28 }, // \n```
    ]);
  });

  it("shows the raw fences when the caret is inside the block", () => {
    expect(hidden(preview(doc, doc.indexOf("const")))).toEqual([]);
  });
});

describe("toggleTaskMarker", () => {
  it("checks an unchecked marker", () => {
    const state = EditorState.create({ doc: "- [ ] todo" });
    expect(toggleTaskMarker(state.doc, 2)).toEqual({
      from: 3,
      to: 4,
      insert: "x",
    });
  });

  it("unchecks a checked marker", () => {
    const state = EditorState.create({ doc: "- [x] done" });
    expect(toggleTaskMarker(state.doc, 2)).toEqual({
      from: 3,
      to: 4,
      insert: " ",
    });
  });

  it("returns undefined when no marker sits at the position", () => {
    const state = EditorState.create({ doc: "plain text" });
    expect(toggleTaskMarker(state.doc, 0)).toBeUndefined();
  });
});

// The reveal gate is recomputed incrementally (scoped to the touched block)
// on a selection-only transaction rather than by walking the whole document
// — these tests drive REAL sequential dispatches (not the one-shot `preview`
// helper) to exercise that incremental path directly and guard against
// duplicate or stale decorations from the previous/next selection's block.
describe("live preview: incremental selection updates", () => {
  it("moving the caret between two headings reveals/hides each exactly once", () => {
    const doc = "# First\n\n## Second\n\nbody";
    const firstPos = doc.indexOf("First") + 1;
    const secondPos = doc.indexOf("Second") + 1;

    let state = EditorState.create({
      doc,
      selection: EditorSelection.single(firstPos),
      extensions: [markdown({ base: markdownLanguage }), livePreview()],
    });
    state = state.update({
      selection: EditorSelection.single(firstPos),
      effects: [setEditorFocused.of(true)],
    }).state;

    // Caret on the first heading: its own marker is revealed, but the
    // untouched second heading's marker stays hidden.
    let field = entries(state.field(livePreviewField));
    expect(withClass(field, "cm-md-h1")).toHaveLength(1);
    expect(withClass(field, "cm-md-h2")).toHaveLength(1);
    expect(hidden(field)).toHaveLength(1);
    expect(hidden(field)).toContainEqual({ from: 9, to: 12 }); // "## "

    // Move the caret to the second heading.
    state = state.update({
      selection: EditorSelection.single(secondPos),
    }).state;
    field = entries(state.field(livePreviewField));
    expect(withClass(field, "cm-md-h1")).toHaveLength(1);
    expect(withClass(field, "cm-md-h2")).toHaveLength(1);
    // The first heading's marker is hidden again; the second's is revealed.
    expect(hidden(field)).toContainEqual({ from: 0, to: 2 });
    expect(hidden(field).some((e) => e.from === doc.indexOf("## "))).toBe(
      false,
    );

    // Move away entirely: both headings' markers hidden, no duplicates.
    state = state.update({
      selection: EditorSelection.single(doc.indexOf("body")),
    }).state;
    field = entries(state.field(livePreviewField));
    expect(withClass(field, "cm-md-h1")).toHaveLength(1);
    expect(withClass(field, "cm-md-h2")).toHaveLength(1);
    expect(hidden(field)).toHaveLength(2);
  });

  it("does not duplicate a link's decoration across repeated no-op selection updates", () => {
    const doc = "See [the docs](https://x.dev) now.";
    const away = doc.indexOf("now");
    let state = EditorState.create({
      doc,
      selection: EditorSelection.single(away),
      extensions: [markdown({ base: markdownLanguage }), livePreview()],
    });
    state = state.update({
      selection: EditorSelection.single(away),
      effects: [setEditorFocused.of(true)],
    }).state;

    // Re-dispatch the SAME selection twice more (a no-op from the app's
    // perspective, but still a selection-setting transaction).
    state = state.update({ selection: EditorSelection.single(away) }).state;
    state = state.update({ selection: EditorSelection.single(away) }).state;
    expect(
      withClass(entries(state.field(livePreviewField)), "cm-md-link"),
    ).toHaveLength(1);

    // Move onto the link (reveals raw source, no cm-md-link mark), then away
    // again — the mark must reappear exactly once, not zero or two times.
    const onLink = doc.indexOf("the docs");
    state = state.update({ selection: EditorSelection.single(onLink) }).state;
    expect(
      withClass(entries(state.field(livePreviewField)), "cm-md-link"),
    ).toHaveLength(0);

    state = state.update({ selection: EditorSelection.single(away) }).state;
    expect(
      withClass(entries(state.field(livePreviewField)), "cm-md-link"),
    ).toHaveLength(1);
  });
});
