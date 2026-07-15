import {
  type Extension,
  type Range as CmRange,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

import type { ReviewRailLayout } from "@/components/review/ReviewRail";

// The review layer on the editor: it paints comment + suggestion ranges as
// CodeMirror decorations and reports where each one sits so a margin rail can
// line up beside it — the editor IS the review surface (no separate rendered
// view). Anchors arrive already translated to SOURCE ranges (comments via
// src/lib/block-offsets, suggestion hunks are source-native), so this module is
// pure CodeMirror: it knows nothing about blocks, plain text, or the anchor
// model. Selection drives an inline Comment/Suggest popover the host renders.

export type ReviewMarkKind = "comment" | "replace" | "delete" | "insert";

// The subset of kinds that paint an inline MARK (span) decoration. Insertion
// points (`"insert"`) have no span to underline — `from === to` — so they get
// a zero-width widget instead (see insertMarkDeco); MARK_CLASS only needs the
// spanned kinds.
export type PaintedMarkKind = Exclude<ReviewMarkKind, "insert">;

// A painted review range. `id` matches the rail's item id (`comment:N` /
// `suggestion:N`) so its measured top keys the rail layout; a suggestion with
// several hunks emits several marks sharing one id (the topmost wins).
export type ReviewMark = Readonly<{
  id: string;
  kind: ReviewMarkKind;
  from: number;
  to: number;
}>;

// A live text selection, positioned relative to the editor's root element so the
// host can place the popover overlay without knowing CodeMirror geometry.
export type ReviewSelection = Readonly<{
  from: number;
  to: number;
  top: number;
  left: number;
}>;

export type LiveReviewConfig = Readonly<{
  onSelect: (selection: ReviewSelection | undefined) => void;
  onLayout: (layout: ReviewRailLayout) => void;
  initialMarks?: readonly ReviewMark[] | undefined;
}>;

// Outlasts the CSS fade (corpus-line-flash); the host clears its flash request
// on the same budget so the cue shows once, then is forgotten. The
// block-indexed flash request itself is the host's concern — this module only
// paints the SourceRanges it is handed.
export const CHANGE_FLASH_DURATION_MS = 5600;

export type SourceRange = Readonly<{ from: number; to: number }>;

// Coalesces coincident layout measurements (a height-changing edit fires both
// the update() and the ResizeObserver in the same frame) into one read.
const LAYOUT_MEASURE_KEY = "live-review-layout";

export const setReviewMarks = StateEffect.define<readonly ReviewMark[]>();
export const setFlashRanges = StateEffect.define<readonly SourceRange[]>();

const marksField = StateField.define<readonly ReviewMark[]>({
  create: () => [],
  update(value, tr) {
    for (const effect of tr.effects)
      if (effect.is(setReviewMarks)) {
        return effect.value;
      }
    return value;
  },
});

const MARK_CLASS: Readonly<Record<PaintedMarkKind, string>> = {
  comment: "cm-md-comment",
  replace: "cm-md-suggest-replace",
  delete: "cm-md-suggest-delete",
};

const markDecoCache = new Map<string, Decoration>();
function markDeco(cls: string): Decoration {
  let deco = markDecoCache.get(cls);
  if (deco === undefined) {
    deco = Decoration.mark({ class: cls });
    markDecoCache.set(cls, deco);
  }
  return deco;
}

// A pure-insertion suggestion has no existing span to underline (`from ===
// to`), so it gets a small inline "+" badge at the seam instead — the
// zero-width equivalent of the comment/replace/delete washes, so scanning
// the body (not just the rail) still surfaces a pending insertion. `eq`
// always true: the widget carries no state of its own. Exported for direct
// `instanceof` assertions in tests (widgets only render DOM on a live view).
export class InsertMarkWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }
  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-md-suggest-insert";
    span.textContent = "+";
    span.title = "Proposed insertion";
    return span;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}
const insertMarkDeco = Decoration.widget({
  widget: new InsertMarkWidget(),
  side: 1,
});

function buildMarkDecorations(
  marks: readonly ReviewMark[],
  docLength: number,
): DecorationSet {
  const sorted = [...marks].sort((a, b) => a.from - b.from);
  const ranges: CmRange<Decoration>[] = [];
  for (const mark of sorted) {
    const from = Math.max(0, Math.min(mark.from, docLength));
    if (mark.kind === "insert") {
      ranges.push(insertMarkDeco.range(from));
      continue;
    }
    const to = Math.max(0, Math.min(mark.to, docLength));
    if (to > from) ranges.push(markDeco(MARK_CLASS[mark.kind]).range(from, to));
  }
  // `true` is safe: we sorted above so ranges are in ascending `from` order.
  return Decoration.set(ranges, true);
}

function marksChanged(tr: {
  effects: readonly StateEffect<unknown>[];
}): boolean {
  return tr.effects.some((effect) => effect.is(setReviewMarks));
}

export const reviewDecorationsField = StateField.define<DecorationSet>({
  create: (state) =>
    buildMarkDecorations(
      state.field(marksField, false) ?? [],
      state.doc.length,
    ),
  update(value, tr) {
    for (const effect of tr.effects)
      if (effect.is(setReviewMarks)) {
        return buildMarkDecorations(effect.value, tr.state.doc.length);
      }
    // Keep marks attached to their text through local edits; the loader's next
    // setReviewMarks rebuilds from canonical positions.
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const flashLineDeco = Decoration.line({ class: "cm-md-flash" });

function buildFlashDecorations(
  ranges: readonly SourceRange[],
  doc: {
    length: number;
    lineAt: (pos: number) => { number: number };
    line: (n: number) => { from: number };
  },
): DecorationSet {
  const decos: CmRange<Decoration>[] = [];
  for (const range of ranges) {
    const from = Math.max(0, Math.min(range.from, doc.length));
    const to = Math.max(from, Math.min(range.to, doc.length));
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(to).number;
    for (let n = first; n <= last; n += 1) {
      decos.push(flashLineDeco.range(doc.line(n).from));
    }
  }
  // Line decorations are pushed in ascending line-number order (each range
  // iterates first→last, and ranges from blockIndexes are block-order), so
  // the set is sorted. Sort defensively to guarantee the `true` contract.
  return Decoration.set(
    decos.sort((a, b) => a.from - b.from),
    true,
  );
}

const flashDecorationsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects)
      if (effect.is(setFlashRanges)) {
        return buildFlashDecorations(effect.value, tr.state.doc);
      }
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Report the active selection (positioned for the popover) on mouse/keyboard
// selection changes. rAF defers the read until CodeMirror has applied the
// selection to the DOM, so coordsAtPos is accurate.
function selectionHandlers(onSelect: LiveReviewConfig["onSelect"]): Extension {
  const report = (view: EditorView): void => {
    // The rAF may fire after the view was torn down (version-keyed remount mid
    // gesture); the detached DOM is the signal to bail.
    if (!view.dom.isConnected) return;
    const sel = view.state.selection.main;
    if (sel.empty) {
      onSelect(undefined);
      return;
    }
    const coords = view.coordsAtPos(sel.from);
    if (coords === null) {
      onSelect(undefined);
      return;
    }
    const base = view.dom.getBoundingClientRect();
    onSelect({
      from: sel.from,
      to: sel.to,
      top: coords.bottom - base.top,
      left: coords.left - base.left,
    });
  };
  return [
    EditorView.domEventHandlers({
      mouseup: (_event, view) => {
        requestAnimationFrame(() => report(view));
        return false;
      },
      keyup: (event, view) => {
        if (event.shiftKey || event.key === "Shift") {
          requestAnimationFrame(() => report(view));
        }
        return false;
      },
    }),
    // Collapsing the selection by a plain arrow key or by typing produces no
    // mouseup/shift-keyup, so close the popover here instead of leaving it open
    // over a stale range.
    EditorView.updateListener.of((u) => {
      if (u.selectionSet && u.state.selection.main.empty) onSelect(undefined);
    }),
  ];
}

// Measure each mark's top relative to the editor root and the editor's height,
// so the rail (a sibling column of equal height) positions cards beside the
// text they annotate — the CodeMirror analogue of measureAnchorTops.
function measureLayout(
  view: EditorView,
  onLayout: LiveReviewConfig["onLayout"],
): void {
  const marks = view.state.field(marksField, false) ?? [];
  const base = view.dom.getBoundingClientRect();
  const docLength = view.state.doc.length;
  const itemTops: Record<string, number> = {};
  for (const mark of marks) {
    const pos = Math.max(0, Math.min(mark.from, docLength));
    // coordsAtPos is precise but returns null outside the rendered viewport;
    // lineBlockAt covers the whole document (estimated line heights) so a
    // comment far below the fold still gets a rail position.
    const coords = view.coordsAtPos(pos);
    const top =
      coords === null
        ? view.documentTop + view.lineBlockAt(pos).top - base.top
        : coords.top - base.top;
    const rounded = Math.round(top);
    const prev = itemTops[mark.id];
    if (prev === undefined || rounded < prev) itemTops[mark.id] = rounded;
  }
  onLayout({ itemTops, documentHeight: Math.round(base.height) });
}

function layoutPlugin(onLayout: LiveReviewConfig["onLayout"]): Extension {
  return ViewPlugin.fromClass(
    class {
      private readonly observer: ResizeObserver | undefined;
      constructor(readonly view: EditorView) {
        this.schedule();
        this.observer =
          typeof ResizeObserver === "undefined"
            ? undefined
            : new ResizeObserver(() => this.schedule());
        this.observer?.observe(view.dom);
      }
      update(u: ViewUpdate): void {
        const didChangeMarks = u.transactions.some(marksChanged);
        const hasMarks = (u.state.field(marksField, false)?.length ?? 0) > 0;
        if (didChangeMarks) this.schedule(true);
        else if (hasMarks && (u.heightChanged || u.viewportChanged))
          this.schedule();
      }
      schedule(force = false): void {
        if (
          !force &&
          (this.view.state.field(marksField, false)?.length ?? 0) === 0
        ) {
          return;
        }
        this.view.requestMeasure({
          key: LAYOUT_MEASURE_KEY,
          read: (view) => {
            measureLayout(view, onLayout);
          },
        });
      }
      destroy(): void {
        this.observer?.disconnect();
      }
    },
  );
}

export function liveReview(config: LiveReviewConfig): Extension {
  return [
    marksField.init(() => config.initialMarks ?? []),
    reviewDecorationsField,
    flashDecorationsField,
    selectionHandlers(config.onSelect),
    layoutPlugin(config.onLayout),
  ];
}
