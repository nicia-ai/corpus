import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  type Range as CmRange,
  StateEffect,
  StateField,
  type Text,
  type Transaction,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";

import { scanWikilinks, splitWikiTarget } from "@/store/domain/links";

import { frontmatter, imageReplace, tableReplace } from "./block-widgets";
import { imageParts, linkParts, type SliceText } from "./inline-spans";
import { wikiLinkResolver } from "./wikilink-facet";

// The Lezer syntax-node type, derived from CodeMirror's public API rather than
// importing @lezer/common directly (it is a transitive dep, not hoisted under
// pnpm — a direct import fails to resolve).
type MdNode = Readonly<ReturnType<ReturnType<typeof syntaxTree>["resolve"]>>;

// Obsidian-style live preview. The markdown source stays the literal edit
// buffer — the canonical bytes the version chain, block anchors, and agent
// suggestion diffs all key off (AGENTS.md "Bundle" / "TypeGraph"). We only
// DECORATE that source so it reads as a rendered document: markers are hidden
// or swapped for a glyph everywhere except the line/span the caret touches,
// which reveals its raw syntax for editing — but only while the editor is
// FOCUSED, so a freshly-opened document renders fully instead of showing the
// first line's raw markers at the caret's default position 0.
//
// Heading SIZES live in the highlight style (on the heading-text token, tagged
// heading1..6 by @lezer/markdown — the `#` is a separate processingInstruction
// token), never on the line. So hiding/revealing the `#` shifts text but never
// changes line height: no reflow on caret reveal (the live-preview gate).
// Vertical rhythm on heading lines is PADDING, not margin — CodeMirror's height
// model includes padding but excludes margin, so a margin on a `.cm-line`
// decoration desyncs its Y geometry from the paint and clicks land off-target.

const HEADING_LEVEL: Readonly<Record<string, number>> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
  SetextHeading1: 1,
  SetextHeading2: 2,
};

// The reveal gate's two inputs, tracked as ONE field (not two) so every
// consumer — touchesSelection, livePreviewField's recompute trigger — checks
// a single thing instead of remembering to OR two independent fields.
// `focused` mirrors real DOM focus, driven by livePreview()'s focus/blur
// handlers. `popoverOpen` covers a gap real focus can't: the inline
// Comment/Suggest popover's own controls (the composer's second stage) take
// native DOM focus — its textareas are `autoFocus` — which blurs the editor.
// Without `popoverOpen`, the gate would close the moment the popover opens
// for editing, collapsing the just-revealed markup back to its rendered form
// under the still-open popover (positioned once at open, never re-measured).
// The host dispatches setReviewPopoverOpen whenever the popover is showing
// for the current selection, keeping the gate open across that focus
// hand-off; both exported effects are also the test seam for simulating
// focus/popover state without a real DOM.
export const setEditorFocused = StateEffect.define<boolean>();
export const setReviewPopoverOpen = StateEffect.define<boolean>();
type RevealGate = Readonly<{ focused: boolean; popoverOpen: boolean }>;
const CLOSED_GATE: RevealGate = { focused: false, popoverOpen: false };
const revealGate = StateField.define<RevealGate>({
  create: () => CLOSED_GATE,
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) {
      if (e.is(setEditorFocused) && e.value !== next.focused) {
        next = { ...next, focused: e.value };
      }
      if (e.is(setReviewPopoverOpen) && e.value !== next.popoverOpen) {
        next = { ...next, popoverOpen: e.value };
      }
    }
    return next;
  },
});

// Shared decoration specs — constant, so build them once instead of per node
// per recompute (computeDecorations runs on every edit and caret move).
const HIDE = Decoration.replace({ mdHide: true });
const CODE_MARK = Decoration.mark({ class: "cm-md-code" });
const TASK_DONE_MARK = Decoration.mark({ class: "cm-md-task-done" });
const TASK_CHECKED = /x/i;

// Line decorations are keyed only by their class string; cache them so the
// constant classes (six heading variants, quote, code block, table, rule)
// allocate once rather than per matching line per recompute.
const lineDecoCache = new Map<string, Decoration>();
function lineDeco(cls: string): Decoration {
  let d = lineDecoCache.get(cls);
  if (d === undefined) {
    d = Decoration.line({ class: cls });
    lineDecoCache.set(cls, d);
  }
  return d;
}

// The reveal gate: does any selection range overlap [from, to] (inclusive)?
// Returns false when the editor is unfocused (and the popover isn't covering
// for it — see revealGate above) or read-only — the document then stays
// fully rendered while select/copy still work on the underlying source.
function touchesSelection(
  state: EditorState,
  from: number,
  to: number,
): boolean {
  if (state.readOnly) return false;
  const gate = state.field(revealGate, false) ?? CLOSED_GATE;
  if (!gate.focused && !gate.popoverOpen) return false;
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

// Does any selection range touch the line(s) spanned by [from, to]?
function touchesLine(state: EditorState, from: number, to: number): boolean {
  const start = state.doc.lineAt(from).from;
  const end = state.doc.lineAt(Math.min(to, state.doc.length)).to;
  return touchesSelection(state, start, end);
}

// Pure change toggling a `[ ]`/`[x]` task marker whose `[` sits at `pos`;
// undefined when the position does not hold a task marker.
export function toggleTaskMarker(
  doc: Text,
  pos: number,
): { from: number; to: number; insert: string } | undefined {
  const marker = doc.sliceString(pos, pos + 3);
  if (!/^\[[ xX]\]$/.test(marker)) return undefined;
  const checked = marker[1] !== " ";
  return { from: pos + 1, to: pos + 2, insert: checked ? " " : "x" };
}

function hide(from: number, to: number): CmRange<Decoration> {
  return HIDE.range(from, to);
}

// Is `pos` inside any code or raw-HTML construct? Wikilinks are scanned
// from the text (Lezer has no node for them), so tree context decides
// whether a match is prose (decorate) or code documentation ABOUT
// wikilinks (leave alone). Shared with the editor's wikilink linter.
const CODE_CONTEXT = /Code|HTML/;
export function inCodeContext(state: EditorState, pos: number): boolean {
  for (
    let node: MdNode | null = syntaxTree(state).resolveInner(pos, 1);
    node !== null;
    node = node.parent
  ) {
    if (CODE_CONTEXT.test(node.name)) return true;
  }
  return false;
}

// Hide a marker token [from, markerEnd) plus ALL whitespace that follows it on
// the line — the shared idiom for `#`, `>`, and a task `-`. CommonMark allows
// any run of spaces/tabs after these markers (`#   Title`, `#\tTitle`), all
// insignificant, so a single-space rule would leak leading whitespace into the
// rendered line.
function hideMarker(
  decos: CmRange<Decoration>[],
  doc: Text,
  from: number,
  markerEnd: number,
): void {
  let end = markerEnd;
  while (end < doc.length) {
    const ch = doc.sliceString(end, end + 1);
    if (ch !== " " && ch !== "\t") break;
    end++;
  }
  if (end > from) decos.push(hide(from, end));
}

function pushLineClass(
  decos: CmRange<Decoration>[],
  state: EditorState,
  from: number,
  to: number,
  cls: string,
): void {
  const first = state.doc.lineAt(from).number;
  const last = state.doc.lineAt(Math.min(to, state.doc.length)).number;
  const deco = lineDeco(cls);
  for (let n = first; n <= last; n++) {
    decos.push(deco.range(state.doc.line(n).from));
  }
}

// A class-tagged <span>; optional text content (the rule draws its divider in
// CSS, so it carries no glyph). Widget semantics keep the glyph out of the
// document's text selection/copy.
class SpanWidget extends WidgetType {
  constructor(
    readonly cls: string,
    readonly glyph = "",
  ) {
    super();
  }
  override eq(other: SpanWidget): boolean {
    return other.cls === this.cls && other.glyph === this.glyph;
  }
  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = this.cls;
    span.textContent = this.glyph;
    return span;
  }
  // Let a click place the caret at the marker (revealing the raw source).
  override ignoreEvent(): boolean {
    return false;
  }
}

const bulletWidget = new SpanWidget("cm-md-bullet", "•");
const ruleWidget = new SpanWidget("cm-md-rule");

class TaskBoxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  override eq(other: TaskBoxWidget): boolean {
    return other.checked === this.checked;
  }
  override toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-md-task-box";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.tabIndex = -1;
    box.setAttribute("aria-label", "Toggle task");
    wrap.appendChild(box);
    wrap.addEventListener("mousedown", (event) => {
      event.preventDefault();
      if (view.state.readOnly) return;
      const change = toggleTaskMarker(view.state.doc, view.posAtDOM(wrap));
      if (change) view.dispatch({ changes: change, userEvent: "input" });
    });
    wrap.addEventListener("click", (event) => {
      event.preventDefault();
    });
    return wrap;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

// Only two distinct task widgets exist (eq compares `checked`), and toDOM takes
// the view as a parameter, so the singletons capture nothing.
const taskBoxChecked = new TaskBoxWidget(true);
const taskBoxUnchecked = new TaskBoxWidget(false);

function decorateInlineMarks(
  decos: CmRange<Decoration>[],
  state: EditorState,
  node: MdNode,
  name: string,
): void {
  if (name === "InlineCode") decos.push(CODE_MARK.range(node.from, node.to));
  if (touchesSelection(state, node.from, node.to)) return;
  const markName =
    name === "InlineCode"
      ? "CodeMark"
      : name === "Strikethrough"
        ? "StrikethroughMark"
        : "EmphasisMark";
  for (const mark of node.getChildren(markName))
    if (mark.to > mark.from) decos.push(hide(mark.from, mark.to));
}

function decorateLink(
  decos: CmRange<Decoration>[],
  state: EditorState,
  node: MdNode,
): void {
  const slice: SliceText = (f, t) => state.doc.sliceString(f, t);
  const parts = linkParts(slice, node);
  if (!parts) return; // reference / bracket-only links stay raw
  if (touchesSelection(state, node.from, node.to)) return;
  if (node.from < parts.labelFrom) decos.push(hide(node.from, parts.labelFrom));
  if (parts.labelTo < node.to) decos.push(hide(parts.labelTo, node.to));
  decos.push(
    Decoration.mark({
      class: "cm-md-link",
      attributes: { title: parts.href, "data-href": parts.href },
    }).range(parts.labelFrom, parts.labelTo),
  );
}

// Images: replace `![alt](src)` with a rendered <img> off-cursor. The alt text
// is extracted from the parsed LinkMark children (not a regex) so brackets
// inside the alt text (`![a [b] c](url)`) resolve correctly — the parser knows
// where the real closing `]` sits, a `[^\]]*` regex does not.
function decorateImage(
  decos: CmRange<Decoration>[],
  state: EditorState,
  node: MdNode,
): void {
  if (touchesLine(state, node.from, node.to)) return; // editing: raw source
  const slice: SliceText = (f, t) => state.doc.sliceString(f, t);
  const parts = imageParts(slice, node);
  if (!parts) return;
  decos.push(imageReplace(node.from, node.to, parts.src, parts.alt));
}

// Task list items: swap the `[ ]`/`[x]` marker for a checkbox widget and strike
// completed task text. The checkbox toggles the marker via a mousedown handler
// (see TaskBoxWidget).
function decorateTask(
  decos: CmRange<Decoration>[],
  state: EditorState,
  node: MdNode,
): void {
  const marker = node.getChild("TaskMarker");
  if (!marker) return;
  const checked = TASK_CHECKED.test(
    state.doc.sliceString(marker.from, marker.to),
  );
  if (checked && node.to > marker.to)
    decos.push(TASK_DONE_MARK.range(marker.to, node.to));
  if (!touchesLine(state, marker.from, marker.to))
    decos.push(
      Decoration.replace({
        widget: checked ? taskBoxChecked : taskBoxUnchecked,
      }).range(marker.from, marker.to),
    );
}

// Bullet markers: replace `-`/`*`/`+` with a glyph widget off-cursor. A task
// line's marker is hidden (the checkbox stands in for it) along with its
// trailing space, so the box aligns with a sibling bullet's glyph.
function decorateListMark(
  decos: CmRange<Decoration>[],
  state: EditorState,
  node: MdNode,
): void {
  const doc = state.doc;
  const text = doc.sliceString(node.from, node.to);
  const isBullet = text === "-" || text === "*" || text === "+";
  if (!isBullet || touchesLine(state, node.from, node.to)) return;
  if (node.parent?.getChild("Task")) {
    hideMarker(decos, doc, node.from, node.to);
    return;
  }
  decos.push(
    Decoration.replace({ widget: bulletWidget }).range(node.from, node.to),
  );
}

// GFM tables: render as a read-only <table> off-cursor (cell content is
// walked from this same syntax tree, so inline markdown renders inside
// cells); the caret on any table line shows the raw source, mono-tagged so
// `|` columns align. Falls back to mono-styled raw source when the table
// node lacks a header.
function decorateTable(
  decos: CmRange<Decoration>[],
  state: EditorState,
  node: MdNode,
): void {
  if (touchesLine(state, node.from, node.to)) {
    pushLineClass(decos, state, node.from, node.to, "cm-md-table");
    return;
  }
  const deco = tableReplace(state, node);
  if (deco) decos.push(deco);
  else pushLineClass(decos, state, node.from, node.to, "cm-md-table");
}

function decorateHorizontalRule(
  decos: CmRange<Decoration>[],
  state: EditorState,
  from: number,
  to: number,
): void {
  pushLineClass(decos, state, from, to, "cm-md-hr");
  if (touchesLine(state, from, to)) return;
  decos.push(Decoration.replace({ widget: ruleWidget }).range(from, to));
}

// Headings: ATX (`# …`) and Setext (`…\n===`). Style ONLY the heading's text
// (first) line — a Setext node also spans its underline line, which must not be
// sized as a heading — and hide the markers off the caret: the ATX `#` prefix
// (and any closing `#`), or the Setext `===`/`---` underline.
function decorateHeading(
  decos: CmRange<Decoration>[],
  state: EditorState,
  node: MdNode,
  name: string,
  level: number,
): void {
  // While the caret is on a Setext heading the `=`/`-` underline is
  // mid-keystroke (the block flips in and out of heading-ness), so leave it raw.
  if (name.startsWith("Setext") && touchesLine(state, node.from, node.to))
    return;
  const textLineTo = state.doc.lineAt(node.from).to;
  pushLineClass(
    decos,
    state,
    node.from,
    textLineTo,
    `cm-md-heading cm-md-h${level}`,
  );
  if (!touchesLine(state, node.from, node.to))
    for (const mark of node.getChildren("HeaderMark"))
      hideMarker(decos, state.doc, mark.from, mark.to);
}

// Fenced code: off-cursor, hide the ```lang opening line and the ``` closing
// line (each with its line break, so the box collapses to just the code) and
// style the body as the code box; the body text is highlighted by the nested
// language (codeLanguages). The caret on any line shows the raw fences for
// editing. Whole-line hiding is allowed because livePreviewField provides
// decorations directly (CM permits directly-provided replaces to cover breaks).
function decorateFencedCode(
  decos: CmRange<Decoration>[],
  state: EditorState,
  from: number,
  to: number,
): void {
  const doc = state.doc;
  const openLine = doc.lineAt(from);
  const closeLine = doc.lineAt(Math.min(to, doc.length));
  // Editing, or a degenerate fence with no body line: show raw, style all lines.
  if (closeLine.number - openLine.number < 2 || touchesLine(state, from, to)) {
    pushLineClass(decos, state, from, to, "cm-md-code-block");
    return;
  }
  const firstBody = doc.line(openLine.number + 1);
  const lastBody = doc.line(closeLine.number - 1);
  decos.push(hide(openLine.from, firstBody.from));
  decos.push(hide(lastBody.to, closeLine.to));
  pushLineClass(decos, state, firstBody.from, lastBody.to, "cm-md-code-block");
}

// The frontmatter panel's reveal is a plain YAML-fence check, not a syntax
// tree node — computed once here and reused by both the full and the
// selection-scoped incremental recompute below.
function frontmatterDecoration(
  state: EditorState,
  fm: ReturnType<typeof frontmatter>,
): CmRange<Decoration> | undefined {
  if (fm === undefined) return undefined;
  return touchesSelection(state, fm.from, Math.max(fm.from, fm.to - 1))
    ? undefined
    : fm.deco;
}

// Obsidian-style wikilinks, scanned from the window's text (no syntax
// node exists for them). Only RESOLVED targets decorate — the brackets
// hide and the target (or `|label`) renders as an internal link whose
// data-href is the resolved slug, so the shared link-follower works
// unchanged. An unresolved target stays raw text (the linter warns on
// it); the caret on the match reveals the raw source for editing, like
// every other construct here. Matches can't straddle the incremental
// window: they contain no newline and windows are block-aligned.
function decorateWikilinks(
  decos: CmRange<Decoration>[],
  state: EditorState,
  from: number,
  to: number,
  fm: ReturnType<typeof frontmatter>,
): void {
  const resolve = state.facet(wikiLinkResolver);
  if (resolve === undefined) return;
  const text = state.doc.sliceString(from, to);
  for (const m of scanWikilinks(text)) {
    const mFrom = from + m.from;
    const mTo = from + m.to;
    if (fm && mFrom < fm.to) continue;
    if (touchesSelection(state, mFrom, mTo)) continue;
    if (inCodeContext(state, mFrom + 2)) continue;
    const { target, labelStart } = splitWikiTarget(m.inner);
    const slug = target === "" ? undefined : resolve(target);
    if (slug === undefined) continue;
    const innerFrom = mFrom + 2;
    const labelFrom =
      labelStart === undefined ? innerFrom : innerFrom + labelStart;
    const labelTo = mTo - 2;
    if (labelTo <= labelFrom) continue;
    decos.push(hide(mFrom, labelFrom));
    decos.push(
      Decoration.mark({
        class: "cm-md-link",
        attributes: { title: `[[${m.inner}]]`, "data-href": slug },
      }).range(labelFrom, labelTo),
    );
    decos.push(hide(labelTo, mTo));
  }
}

// Build the tree-based decorations for every node OVERLAPPING [from, to).
// Lezer's bounded iterate visits an overlapping node with its own FULL
// from/to (never clipped to the window), and each handler below decides
// hide/reveal from the state's actual current selection (not from the
// window) — so bounding the walk only changes which nodes get re-examined,
// never how a re-examined node's decoration is computed. That's what makes
// it safe for computeDecorationsInRange to be called with a window far
// narrower than the whole document (see updateForSelectionChange). `fm` is
// threaded in rather than recomputed here — frontmatter() re-stringifies and
// re-parses the whole document, so every caller computes it once per state
// and shares it across this, frontmatterDecoration, and its own frontmatter
// splice, instead of paying for it 2-4x per recompute.
function computeDecorationsInRange(
  state: EditorState,
  from: number,
  to: number,
  fm: ReturnType<typeof frontmatter>,
): CmRange<Decoration>[] {
  const decos: CmRange<Decoration>[] = [];

  // `ref` is the cheap cursor (name/from/to without allocating); materialize
  // `ref.node` only in the branches that walk children, so the majority of
  // nodes (paragraphs, text, …) cost nothing.
  syntaxTree(state).iterate({
    from,
    to,
    enter: (ref): void => {
      const { name, from: nodeFrom, to: nodeTo } = ref;
      if (fm && nodeFrom < fm.to) return; // inside the frontmatter fence

      const level = HEADING_LEVEL[name];
      if (level !== undefined) {
        decorateHeading(decos, state, ref.node, name, level);
        return;
      }

      switch (name) {
        case "Emphasis":
        case "StrongEmphasis":
        case "Strikethrough":
        case "InlineCode":
          decorateInlineMarks(decos, state, ref.node, name);
          return;

        case "Link":
          decorateLink(decos, state, ref.node);
          return;

        case "Image":
          decorateImage(decos, state, ref.node);
          return;

        case "Task":
          decorateTask(decos, state, ref.node);
          return;

        case "ListMark":
          decorateListMark(decos, state, ref.node);
          return;

        case "Blockquote":
          pushLineClass(decos, state, nodeFrom, nodeTo, "cm-md-quote");
          return;
        case "QuoteMark":
          if (!touchesLine(state, nodeFrom, nodeTo))
            hideMarker(decos, state.doc, nodeFrom, nodeTo);
          return;

        case "FencedCode":
          decorateFencedCode(decos, state, nodeFrom, nodeTo);
          return;

        case "Table":
          decorateTable(decos, state, ref.node);
          return;

        case "HorizontalRule":
          decorateHorizontalRule(decos, state, nodeFrom, nodeTo);
          return;
      }
    },
  });

  decorateWikilinks(decos, state, from, to, fm);

  // A single node's own pushes aren't necessarily in ascending `from` order
  // (e.g. decorateLink pushes the open-bracket hide, then the close-paren
  // hide, then the label mark — which starts before the close hide), and
  // `RangeSet.update`'s `add` (unlike `Decoration.set`'s optional sort)
  // requires its input pre-sorted by (from, startSide) — mirror
  // RangeSet's own comparator so this is a valid `add` array either way.
  decos.sort(
    (a, b) => a.from - b.from || a.value.startSide - b.value.startSide,
  );
  return decos;
}

function computeDecorations(state: EditorState): DecorationSet {
  const fm = frontmatter(state);
  const fmDeco = frontmatterDecoration(state, fm);
  const decos = computeDecorationsInRange(state, 0, state.doc.length, fm);
  return Decoration.set(fmDeco ? [fmDeco, ...decos] : decos, true);
}

// Walk from `pos` up to the node whose PARENT is the tree's own root — the
// top-level block (heading / paragraph / list / table / fenced code / …)
// that contains it. Every decoration a node inside that block can produce
// (hide markers, line classes, mark spans) falls within the block's own
// [from, to) — e.g. a heading's line-class decoration sits at the LINE
// START, which can be well before the caret position inside it — so
// snapping a selection endpoint out to its enclosing top-level block (rather
// than using the bare position) keeps the incremental filter/add window in
// updateForSelectionChange wide enough to fully replace, never duplicate,
// every decoration a re-examined node can produce.
function topLevelNodeRange(
  state: EditorState,
  pos: number,
): readonly [number, number] {
  let node = syntaxTree(state).resolve(pos, 1);
  while (node.parent !== null && node.parent.parent !== null) {
    node = node.parent;
  }
  return [node.from, node.to];
}

// A selection-only change (the common case: a click, an arrow key, a
// shift-drag) can only flip the reveal gate for nodes that overlap the OLD
// or the NEW selection — every other node's decoration is provably
// unaffected — so re-decorate just the union of those ranges instead of the
// whole document. `RangeSet.update`'s filterFrom/filterTo scopes both what
// gets dropped and where the freshly computed ranges are spliced back in,
// leaving the rest of the previous set untouched via structural sharing.
function updateForSelectionChange(
  value: DecorationSet,
  tr: Transaction,
): DecorationSet {
  const allRanges = [
    ...tr.startState.selection.ranges,
    ...tr.state.selection.ranges,
  ];
  // Memoized by position: a collapsed caret has r.from === r.to, and a
  // no-op selection re-dispatch (the same value set again) repeats old and
  // new positions — resolving the same syntax-tree position more than once
  // is wasted work on this hot path (every arrow key / click).
  const topLevelCache = new Map<number, readonly [number, number]>();
  const topLevelAt = (pos: number): readonly [number, number] => {
    let range = topLevelCache.get(pos);
    if (range === undefined) {
      range = topLevelNodeRange(tr.state, pos);
      topLevelCache.set(pos, range);
    }
    return range;
  };
  let from = Infinity;
  let to = -Infinity;
  for (const r of allRanges) {
    from = Math.min(from, topLevelAt(r.from)[0]);
    to = Math.max(to, topLevelAt(r.to)[1]);
  }
  const fm = frontmatter(tr.state);
  let next = value.update({
    filterFrom: from,
    filterTo: to,
    filter: () => false,
    add: computeDecorationsInRange(tr.state, from, to, fm),
  });

  // Frontmatter isn't part of the syntax-tree walk above (it's a separate
  // YAML-fence check), so splice it in/out independently — only when its own
  // reveal gate actually flips (the doc is unchanged here, so the fence
  // itself, if any, is identical before and after — hence one `fm` computed
  // above serves both the before and after check).
  const before = frontmatterDecoration(tr.startState, fm);
  const after = frontmatterDecoration(tr.state, fm);
  if ((before === undefined) !== (after === undefined)) {
    if (fm !== undefined) {
      next = next.update({
        filterFrom: 0,
        filterTo: fm.to,
        filter: () => false,
        add: after ? [after] : [],
      });
    }
  }
  return next;
}

// Map the existing decorations through the edit, then rebuild only the
// top-level blocks touched by the change and the caret. Markdown can change
// the parse shape of a neighboring block (for example, deleting a blank line),
// so the one-character padding deliberately pulls both adjacent blocks into
// the replacement window.
function updateForDocChange(
  value: DecorationSet,
  tr: Transaction,
): DecorationSet {
  let from = tr.state.doc.length;
  let to = 0;
  const include = (pos: number): void => {
    const clamped = Math.max(0, Math.min(pos, tr.state.doc.length));
    const range = topLevelNodeRange(tr.state, clamped);
    from = Math.min(from, range[0]);
    to = Math.max(to, range[1]);
  };

  const includeOld = (pos: number): void => {
    const clamped = Math.max(0, Math.min(pos, tr.startState.doc.length));
    const range = topLevelNodeRange(tr.startState, clamped);
    from = Math.min(from, tr.changes.mapPos(range[0], -1));
    to = Math.max(to, tr.changes.mapPos(range[1], 1));
  };

  tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    // Include both parse shapes. Removing a fence can split one old block into
    // many new ones; adding one can merge many old blocks into one new block.
    // Either shape may therefore define the larger invalidation window.
    includeOld(fromA - 1);
    includeOld(toA + 1);
    include(fromB - 1);
    include(toB + 1);
  });
  for (const range of tr.state.selection.ranges) {
    include(range.from);
    include(range.to);
  }

  const beforeFrontmatter = frontmatter(tr.startState);
  const afterFrontmatter = frontmatter(tr.state);
  if (beforeFrontmatter !== undefined || afterFrontmatter !== undefined) {
    const end = Math.max(beforeFrontmatter?.to ?? 0, afterFrontmatter?.to ?? 0);
    if (from <= end) from = 0;
  }

  const add = computeDecorationsInRange(tr.state, from, to, afterFrontmatter);
  const fmDeco =
    from === 0 ? frontmatterDecoration(tr.state, afterFrontmatter) : undefined;
  return value.map(tr.changes).update({
    filterFrom: from,
    filterTo: to,
    filter: () => false,
    add: fmDeco === undefined ? add : [fmDeco, ...add],
  });
}

// Recompute when the doc, the selection, the focus state, or the readOnly facet
// changes (each flips the reveal gate), or when the async parse advances.
// Deliberately NOT on every `tr.reconfigured`: the editor reconfigures the
// broken-link linter compartment on each title keystroke (selfSlug changes), so
// a blanket reconfigure rebuild would re-decorate the whole body per keystroke.
// readOnly is the only gate-relevant facet, so check it directly.
export const livePreviewField = StateField.define<DecorationSet>({
  create: computeDecorations,
  update(value, tr) {
    if (tr.docChanged) return updateForDocChange(value, tr);
    if (
      tr.startState.field(revealGate) !== tr.state.field(revealGate) ||
      tr.startState.readOnly !== tr.state.readOnly ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState)
    )
      return computeDecorations(tr.state);
    if (tr.selection) return updateForSelectionChange(value, tr);
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const focusWatcher = EditorView.domEventHandlers({
  focus: (_event, view) => {
    view.dispatch({ effects: setEditorFocused.of(true) });
  },
  blur: (_event, view) => {
    view.dispatch({ effects: setEditorFocused.of(false) });
  },
});

export function livePreview(): Extension {
  return [revealGate, focusWatcher, livePreviewField];
}
