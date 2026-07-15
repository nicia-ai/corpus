import type { EditorState, Range as CmRange } from "@codemirror/state";
import { Decoration, WidgetType } from "@codemirror/view";

import { cardClass } from "@/components/ui/Surface";
import {
  formatFrontmatterValue,
  parseFrontmatter,
} from "@/store/domain/frontmatter";

import {
  type InlineNode,
  type InlineSpan,
  inlineSpans,
  type SliceText,
  type WikiResolve,
} from "./inline-spans";
import { wikiLinkResolver } from "./wikilink-facet";

// Block-level live-preview widgets — the rich renderers that make the editor a
// faithful read surface: images, GFM tables (read-only render; edit the
// source), and the leading YAML frontmatter as a metadata panel. Each is the
// off-cursor form; live-preview.ts gates them behind the reveal predicate
// (caret on the block → raw source). All DOM is plain (CM widgets), styled with
// Tailwind utility-class literals so it matches the rendered `.md` surface
// without an editor-theme rule. Class strings stay literal so Tailwind's source
// scanner generates them.

// --- Images -----------------------------------------------------------------

// Shared by the standalone image widget and images inside table cells.
const IMAGE_CLASS = "my-1 inline-block max-w-full rounded-md align-bottom";

function imageElement(src: string, alt: string): HTMLElement {
  const img = document.createElement("img");
  img.className = IMAGE_CLASS;
  img.src = src;
  img.alt = alt;
  img.loading = "lazy";
  return img;
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }
  override eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }
  override toDOM(): HTMLElement {
    return imageElement(this.src, this.alt);
  }
  // A click places the caret in the image syntax (revealing it for editing).
  override ignoreEvent(): boolean {
    return false;
  }
}

// Replace `![alt](src)` [from, to) with a rendered <img>. src/alt are extracted
// by the caller (live-preview) from the Image node, mirroring how it reads a
// Link's URL child; src passes through as-written (external/relative/data),
// exactly as react-markdown renders it.
export function imageReplace(
  from: number,
  to: number,
  src: string,
  alt: string,
): CmRange<Decoration> {
  return Decoration.replace({ widget: new ImageWidget(src, alt) }).range(
    from,
    to,
  );
}

// --- GFM tables -------------------------------------------------------------

type TableAlign = "left" | "right" | "center" | "";

// The rendered model of a GFM table: per-column alignment plus header and
// body cells as inline-span lists (inline-spans.ts), so `**bold**`,
// `` `code` ``, links, and images render inside cells exactly as they do
// in body prose — matching remark-gfm, the read view's renderer for the
// same document. Cells are trimmed span lists indexed by COLUMN (an empty
// interior cell `| a || b |` keeps its slot). Exported for unit testing
// the tree walk directly, without standing up an EditorState + widget DOM.
export type TableModel = Readonly<{
  aligns: readonly TableAlign[];
  header: readonly (readonly InlineSpan[])[];
  rows: readonly (readonly (readonly InlineSpan[])[])[];
}>;

// Column alignments from the delimiter line (`| :-: | ---: |`). Escaped
// pipes can't occur in a well-formed delimiter row, so a plain split is
// faithful here (cell content goes through the syntax tree instead). The
// optional leading/trailing `|` leaves empty boundary segments; interior
// alignment cells are never empty (each is `---`/`:-:`), so dropping every
// empty segment keeps exactly the real columns.
function parseAligns(delimLine: string): TableAlign[] {
  return delimLine
    .trim()
    .split("|")
    .map((c) => c.trim())
    .filter((c) => c !== "")
    .map((d) => {
      const l = d.startsWith(":");
      const r = d.endsWith(":");
      return l && r ? "center" : r ? "right" : l ? "left" : "";
    });
}

// Lezer's cell text spans include surrounding whitespace padding
// (`| one |` → cell node covers `one` only, but be safe for edge parses);
// GFM trims cell content, so trim the leading/trailing text spans.
function trimSpans(spans: readonly InlineSpan[]): readonly InlineSpan[] {
  const first = spans[0];
  const last = spans[spans.length - 1];
  const needsTrim =
    (first?.kind === "text" && /^\s/.test(first.text)) ||
    (last?.kind === "text" && /\s$/.test(last.text));
  if (!needsTrim) return spans; // Lezer already excludes cell padding.
  const out = [...spans];
  const head = out[0];
  if (head?.kind === "text") {
    const text = head.text.replace(/^\s+/, "");
    if (text === "") out.shift();
    else out[0] = { kind: "text", text };
  }
  const tail = out[out.length - 1];
  if (tail?.kind === "text") {
    const text = tail.text.replace(/\s+$/, "");
    if (text === "") out.pop();
    else out[out.length - 1] = { kind: "text", text };
  }
  return out;
}

// Cells of one header/body row, indexed by column. Lezer emits NO
// TableCell node for an empty interior cell (`| one || two |` is
// delimiter, cell, delimiter, delimiter, cell, delimiter), so the column
// index is derived from the count of delimiters preceding the cell — a
// leading `|` opens column 0, a pipe-less row starts directly in it.
function rowCells(
  slice: SliceText,
  row: InlineNode,
  wiki: WikiResolve | undefined,
): readonly (readonly InlineSpan[])[] {
  const cells: (readonly InlineSpan[])[] = [];
  const leadingDelim = row.firstChild?.name === "TableDelimiter";
  let delims = 0;
  for (let child = row.firstChild; child !== null; child = child.nextSibling) {
    if (child.name === "TableDelimiter") {
      delims += 1;
    } else if (child.name === "TableCell") {
      const col = delims - (leadingDelim ? 1 : 0);
      cells[col] = trimSpans(
        inlineSpans(slice, child, child.from, child.to, wiki),
      );
    }
  }
  for (let i = 0; i < cells.length; i += 1) cells[i] ??= [];
  return cells;
}

// Build the rendered table model from the already-parsed Table node —
// the cells' inline markdown arrives pre-parsed as the node's children,
// so no second parser pass runs and the widget can never disagree with
// the editor's own syntax tree. Undefined when the node lacks a header
// (left as raw source by the caller).
export function tableModelFromTree(
  slice: SliceText,
  table: InlineNode,
  wiki?: WikiResolve,
): TableModel | undefined {
  const headerNode = table.getChild("TableHeader");
  if (headerNode === null) return undefined;
  // The alignment line is the TableDelimiter that is a DIRECT child of
  // Table (cell separators are children of TableHeader/TableRow).
  const delim = table.getChild("TableDelimiter");
  return {
    aligns: delim === null ? [] : parseAligns(slice(delim.from, delim.to)),
    header: rowCells(slice, headerNode, wiki),
    rows: table.getChildren("TableRow").map((r) => rowCells(slice, r, wiki)),
  };
}

// Render a span list into a parent element. Inline visuals reuse the
// editor's own classes (`cm-md-code`, `cm-md-link`) so designTheme rules
// style widget internals identically to body prose; links carry
// `data-href`, so the editor's shared mousedown handler (plain click in
// read views, Cmd/Ctrl-click while editing) follows them from inside the
// table exactly like a body link.
function appendSpans(el: HTMLElement, spans: readonly InlineSpan[]): void {
  for (const s of spans) {
    switch (s.kind) {
      case "text":
        el.appendChild(document.createTextNode(s.text));
        break;
      case "code": {
        const code = document.createElement("code");
        code.className = "cm-md-code";
        code.textContent = s.text;
        el.appendChild(code);
        break;
      }
      case "image":
        el.appendChild(imageElement(s.src, s.alt));
        break;
      case "link": {
        const link = document.createElement("span");
        link.className = "cm-md-link";
        link.title = s.href;
        link.setAttribute("data-href", s.href);
        appendSpans(link, s.children);
        el.appendChild(link);
        break;
      }
      default: {
        const wrap = document.createElement(s.kind);
        appendSpans(wrap, s.children);
        el.appendChild(wrap);
        break;
      }
    }
  }
}

class TableWidget extends WidgetType {
  // `src` drives eq (cheap string compare for redraw decisions); `model` is
  // the pre-parsed table, computed once in tableReplace so toDOM doesn't
  // re-parse.
  constructor(
    readonly src: string,
    readonly model: TableModel,
  ) {
    super();
  }
  override eq(other: TableWidget): boolean {
    return other.src === this.src;
  }
  override toDOM(): HTMLElement {
    const { model } = this;
    const table = document.createElement("table");
    table.className = "my-3 border-collapse text-sm";
    // Alignment is fixed per column, so precompute each column's header and
    // body class once instead of re-deriving the ternary for every cell.
    const colCount = model.header.length;
    const thClass: string[] = [];
    const tdClass: string[] = [];
    for (let i = 0; i < colCount; i += 1) {
      const align =
        model.aligns[i] === "right"
          ? "text-right"
          : model.aligns[i] === "center"
            ? "text-center"
            : "text-left";
      thClass[i] =
        `border border-slate-200 bg-slate-50 px-3 py-2 font-medium ${align}`;
      tdClass[i] = `border border-slate-200 px-3 py-2 ${align}`;
    }

    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    model.header.forEach((cell, i) => {
      const th = document.createElement("th");
      th.className = thClass[i] ?? "";
      appendSpans(th, cell);
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const row of model.rows) {
      const tr = document.createElement("tr");
      for (let i = 0; i < colCount; i += 1) {
        const td = document.createElement("td");
        td.className = tdClass[i] ?? "";
        appendSpans(td, row[i] ?? []);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    return table;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

// Replace a GFM table block with a rendered (read-only) <table>. The caller
// passes the parsed Table node; the block range is line-aligned. Returns
// undefined when the node lacks a table header (left as raw source).
// The model is built here so the widget's toDOM never re-walks the tree.
export function tableReplace(
  state: EditorState,
  table: InlineNode,
): CmRange<Decoration> | undefined {
  const from = state.doc.lineAt(table.from).from;
  const to = state.doc.lineAt(Math.min(table.to, state.doc.length)).to;
  const slice: SliceText = (f, t) => state.doc.sliceString(f, t);
  const model = tableModelFromTree(slice, table, state.facet(wikiLinkResolver));
  if (model === undefined) return undefined;
  const src = state.doc.sliceString(from, to);
  return Decoration.replace({
    widget: new TableWidget(src, model),
    block: true,
  }).range(from, to);
}

// --- Frontmatter panel ------------------------------------------------------

class FrontmatterWidget extends WidgetType {
  // `src` (the raw fence text) drives eq so the panel redraws on any change.
  constructor(
    readonly src: string,
    readonly entries: readonly (readonly [string, unknown])[],
  ) {
    super();
  }
  override eq(other: FrontmatterWidget): boolean {
    return other.src === this.src;
  }
  override toDOM(): HTMLElement {
    const card = document.createElement("div");
    // Mirror Markdown.tsx's FrontmatterPanel: a slate-100 card (reads on the
    // white document ground) with an uppercase eyebrow over a key/value grid.
    card.className = cardClass("my-2 bg-slate-100 px-6! py-4! sm:px-8!");
    const eyebrow = document.createElement("div");
    eyebrow.className =
      "mb-2 text-sm font-medium tracking-wide text-slate-500 uppercase";
    eyebrow.textContent = "Metadata";
    card.appendChild(eyebrow);
    const dl = document.createElement("dl");
    dl.className =
      "grid grid-cols-[minmax(6rem,max-content)_1fr] gap-x-4 gap-y-1 text-base";
    for (const [k, v] of this.entries) {
      const dt = document.createElement("dt");
      dt.className = "font-medium text-slate-500 tabular-nums";
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.className = "text-slate-900 [overflow-wrap:anywhere]";
      dd.textContent = formatFrontmatterValue(v);
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    card.appendChild(dl);
    return card;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

// The leading YAML frontmatter fence, if present AND it carries metadata. The
// fence region is [0, raw.length - body.length) — `body` is a suffix of the
// document (parseFrontmatter) — and is line-aligned (body starts a line).
// Returns the range plus the panel decoration; live-preview uses the range to
// gate the reveal (caret inside → raw YAML) and pushes the deco off-cursor.
// A frontmatter fence can only start at byte 0 with a `---` line. This
// matches the OPEN regex in frontmatter.ts but without requiring a newline
// (a line's .text excludes its terminator), so it's a cheap first-line filter.
const OPEN_FENCE = /^---[ \t]*$/;

export function frontmatter(state: EditorState):
  | {
      readonly from: number;
      readonly to: number;
      readonly deco: CmRange<Decoration>;
    }
  | undefined {
  // Fast path: computeDecorations calls this on every keystroke and caret
  // move. The vast majority of documents have no frontmatter, so checking
  // the first line avoids a full-document toString() + YAML parse per edit.
  // A `---` first line that's actually a thematic break falls through to
  // the full parse, which correctly returns "no frontmatter".
  if (!OPEN_FENCE.test(state.doc.lineAt(0).text)) return undefined;
  const raw = state.doc.toString();
  const fm = parseFrontmatter(raw);
  if (!fm.ok || fm.frontmatter === undefined) return undefined;
  const to = raw.length - fm.body.length;
  if (to <= 0) return undefined;
  const entries = Object.entries(fm.frontmatter);
  const src = raw.slice(0, to);
  return {
    from: 0,
    to,
    deco: Decoration.replace({
      widget: new FrontmatterWidget(src, entries),
      block: true,
    }).range(0, to),
  };
}
