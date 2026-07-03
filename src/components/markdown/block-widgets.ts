import type { EditorState, Range as CmRange } from "@codemirror/state";
import { Decoration, WidgetType } from "@codemirror/view";

import { cardClass } from "@/components/ui/Surface";
import {
  formatFrontmatterValue,
  parseFrontmatter,
} from "@/store/domain/frontmatter";

// Block-level live-preview widgets — the rich renderers that make the editor a
// faithful read surface: images, GFM tables (read-only render; edit the
// source), and the leading YAML frontmatter as a metadata panel. Each is the
// off-cursor form; live-preview.ts gates them behind the reveal predicate
// (caret on the block → raw source). All DOM is plain (CM widgets), styled with
// Tailwind utility-class literals so it matches the rendered `.md` surface
// without an editor-theme rule. Class strings stay literal so Tailwind's source
// scanner generates them.

// --- Images -----------------------------------------------------------------

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
    const img = document.createElement("img");
    img.className = "my-1 inline-block max-w-full rounded-md align-bottom";
    img.src = this.src;
    img.alt = this.alt;
    img.loading = "lazy";
    return img;
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

// Exported for unit testing splitRow/parseTable's cell-splitting behavior
// directly, without standing up an EditorState + widget DOM.
export type TableModel = Readonly<{
  aligns: readonly TableAlign[];
  header: readonly string[];
  rows: readonly (readonly string[])[];
}>;

// Split a GFM table row into cells, honoring a backslash-escaped `|` as
// literal cell content rather than a column separator (matching remark-gfm,
// the read view's renderer for the same document — a naive `split("|")`
// diverges from it on any escaped pipe).
function splitRow(line: string): string[] {
  const trimmed = line.trim();
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i] ?? "";
    if (ch === "\\" && trimmed[i + 1] === "|") {
      cell += "|";
      i += 1;
      continue;
    }
    if (ch === "|") {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += ch;
  }
  cells.push(cell.trim());
  // A leading/trailing `|` is an optional GFM row delimiter, producing an
  // empty boundary cell here; drop it. An escaped `\|` never reaches this
  // branch as a delimiter, so a genuinely empty interior cell (`| a || b |`)
  // is preserved.
  if (cells.length > 1 && cells[0] === "") cells.shift();
  if (cells.length > 1 && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

export function parseTable(src: string): TableModel | undefined {
  const [headerLine, delimLine, ...bodyLines] = src
    .split("\n")
    .filter((l) => l.trim() !== "");
  if (headerLine === undefined || delimLine === undefined) return undefined;
  const aligns: TableAlign[] = splitRow(delimLine).map((d) => {
    const l = d.startsWith(":");
    const r = d.endsWith(":");
    return l && r ? "center" : r ? "right" : l ? "left" : "";
  });
  return {
    aligns,
    header: splitRow(headerLine),
    rows: bodyLines.map(splitRow),
  };
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
    const alignClass = (i: number): string =>
      model.aligns[i] === "right"
        ? "text-right"
        : model.aligns[i] === "center"
          ? "text-center"
          : "text-left";

    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    model.header.forEach((cell, i) => {
      const th = document.createElement("th");
      th.className = `border border-slate-200 bg-slate-50 px-3 py-2 font-medium ${alignClass(i)}`;
      th.textContent = cell;
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const row of model.rows) {
      const tr = document.createElement("tr");
      model.header.forEach((_h, i) => {
        const td = document.createElement("td");
        td.className = `border border-slate-200 px-3 py-2 ${alignClass(i)}`;
        td.textContent = row[i] ?? "";
        tr.appendChild(td);
      });
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
// passes the Table node range; the block range is line-aligned. Returns
// undefined when the source doesn't parse as a table (left as raw source).
// The parsed model is passed to the widget so toDOM doesn't re-parse.
export function tableReplace(
  state: EditorState,
  nodeFrom: number,
  nodeTo: number,
): CmRange<Decoration> | undefined {
  const from = state.doc.lineAt(nodeFrom).from;
  const to = state.doc.lineAt(Math.min(nodeTo, state.doc.length)).to;
  const src = state.doc.sliceString(from, to);
  const model = parseTable(src);
  if (model === undefined) return undefined;
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
    card.className = cardClass("my-2 bg-slate-100 px-6 py-4 sm:px-8");
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
