import { indentLess, indentMore, isolateHistory } from "@codemirror/commands";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import {
  type ChangeSpec,
  EditorSelection,
  type EditorState,
  type StateCommand,
} from "@codemirror/state";
import type { KeyBinding } from "@codemirror/view";

import { frontmatter } from "./block-widgets";

type MdNode = Readonly<ReturnType<ReturnType<typeof syntaxTree>["resolve"]>>;
type Target = Readonly<Parameters<StateCommand>[0]>;

// Commands change only the selected source. Each is one undo event; none
// serializes the document or replaces the editor state.
function apply(
  target: Target,
  changes: ChangeSpec,
  selection?: EditorSelection,
): boolean {
  if (target.state.readOnly) return false;
  target.dispatch(
    target.state.update({
      changes,
      ...(selection === undefined ? {} : { selection }),
      annotations: isolateHistory.of("full"),
      userEvent: "input.format",
      scrollIntoView: true,
    }),
  );
  return true;
}

function nodeAt(state: EditorState, pos: number): MdNode {
  return (ensureSyntaxTree(state, pos, 50) ?? syntaxTree(state)).resolveInner(
    pos,
    1,
  );
}

function protectedRange(
  state: EditorState,
  from: number,
  to: number,
  inlineCode = false,
): boolean {
  const fm = frontmatter(state);
  if (fm !== undefined && from < fm.to) return true;
  const tree = ensureSyntaxTree(state, to, 50) ?? syntaxTree(state);
  let protectedContent = false;
  tree.iterate({
    from,
    to,
    enter: (node) => {
      if (
        /FencedCode|CodeBlock|HTML/.test(node.name) ||
        (inlineCode && node.name === "InlineCode")
      ) {
        protectedContent = true;
      }
    },
  });
  return protectedContent;
}

function inlineCommand(marker: string, nodeName: string): StateCommand {
  return (target) => {
    const { state } = target;
    if (state.readOnly || state.selection.ranges.length !== 1) return false;
    const range = state.selection.main;
    if (protectedRange(state, range.from, range.to, marker !== "`"))
      return false;
    // A caret or selection inside an existing span toggles that span off.
    for (
      let node: MdNode | null = nodeAt(state, range.from);
      node !== null;
      node = node.parent
    ) {
      if (node.name === nodeName && node.to >= range.to) {
        const first = node.firstChild;
        const last = node.lastChild;
        if (first === null || last === null) break;
        const changes = state.changes([
          { from: first.from, to: first.to },
          { from: last.from, to: last.to },
        ]);
        return apply(
          target,
          changes,
          range.empty
            ? state.selection.map(changes)
            : EditorSelection.single(
                changes.mapPos(range.anchor),
                changes.mapPos(range.head),
              ),
        );
      }
    }
    const selected = state.sliceDoc(range.from, range.to);
    if (selected.includes("\n")) return false;
    // Keep whitespace outside emphasis markers so the result parses as Markdown.
    const leading = /^\s*/.exec(selected)?.[0].length ?? 0;
    const trailing = /\s*$/.exec(selected)?.[0].length ?? 0;
    if (!range.empty && leading === selected.length) return false;
    const from = range.from + leading;
    const to = range.to - trailing;
    const text = state.sliceDoc(from, to);
    const delimiter =
      marker === "`" && text.includes("`")
        ? "`".repeat(
            Math.max(...[...text.matchAll(/`+/g)].map((m) => m[0].length)) + 1,
          )
        : marker;
    const padding =
      marker === "`" && (text.startsWith("`") || text.endsWith("`")) ? " " : "";
    const prefix = delimiter + padding;
    const start = from + prefix.length;
    return apply(
      target,
      { from, to, insert: prefix + text + padding + delimiter },
      EditorSelection.single(
        range.anchor <= range.head ? start : start + text.length,
        range.anchor <= range.head ? start + text.length : start,
      ),
    );
  };
}

export const toggleBold: StateCommand = inlineCommand("**", "StrongEmphasis");
export const toggleItalic: StateCommand = inlineCommand("*", "Emphasis");
export const toggleStrike: StateCommand = inlineCommand("~~", "Strikethrough");
export const toggleInlineCode: StateCommand = inlineCommand("`", "InlineCode");

export const insertLink: StateCommand = (target) => {
  const { state } = target;
  if (state.readOnly) return false;
  const range = state.selection.main;
  if (
    state.selection.ranges.length !== 1 ||
    protectedRange(state, range.from, range.to, true)
  )
    return false;
  // Existing links select the destination for editing instead of nesting links.
  for (
    let node: MdNode | null = nodeAt(state, range.from);
    node !== null;
    node = node.parent
  ) {
    if (node.name === "Link" && node.to >= range.to) {
      const url = node.getChild("URL");
      if (url !== null) {
        target.dispatch(
          state.update({
            selection: EditorSelection.single(url.from, url.to),
            scrollIntoView: true,
          }),
        );
        return true;
      }
    }
  }
  const text = state.sliceDoc(range.from, range.to);
  if (text.includes("\n") || /[[\]\\]/.test(text)) return false;
  const label = text === "" ? "link text" : text;
  const insert = `[${label}](https://)`;
  const from = range.from + (range.empty ? 1 : label.length + 3);
  return apply(
    target,
    { from: range.from, to: range.to, insert },
    EditorSelection.single(
      from,
      from + (range.empty ? label.length : "https://".length),
    ),
  );
};

export type BlockStyle =
  "paragraph" | "heading" | "quote" | "bullet" | "ordered" | "task";

export function setBlockStyle(style: BlockStyle): StateCommand {
  return (target) => {
    const { state } = target;
    if (state.readOnly || state.selection.ranges.length !== 1) return false;
    const range = state.selection.main;
    const first = state.doc.lineAt(range.from);
    const last = state.doc.lineAt(
      range.empty ? range.to : Math.max(range.from, range.to - 1),
    );
    if (protectedRange(state, first.from, last.to, true)) return false;
    const changes: ChangeSpec[] = [];
    for (let number = first.number; number <= last.number; number += 1) {
      const line = state.doc.line(number);
      // Change a single leading block marker, leaving indentation and body intact.
      const match =
        /^(\s*)(#{1,6}\s+|>\s?|(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?/.exec(
          line.text,
        );
      const indentation = match?.[1] ?? "";
      const old = match?.[2] ?? "";
      const prefixes: Readonly<Record<BlockStyle, string>> = {
        paragraph: "",
        heading: "## ",
        quote: "> ",
        bullet: "- ",
        ordered: `${number - first.number + 1}. `,
        task: "- [ ] ",
      };
      changes.push({
        from: line.from + indentation.length,
        to: line.from + indentation.length + old.length,
        insert: prefixes[style],
      });
    }
    const changeSet = state.changes(changes);
    return apply(target, changeSet, state.selection.map(changeSet));
  };
}

// A list item's children move with it. Ordered-list nesting uses the preceding
// item's content column (e.g. four spaces after `10. `), not a fixed tab width.
function shiftList(target: Target, removing: boolean): boolean {
  const { state } = target;
  if (state.readOnly || state.selection.ranges.length !== 1) return false;
  const range = state.selection.main;
  let item: MdNode | null = nodeAt(state, range.from);
  while (item !== null && item.name !== "ListItem") item = item.parent;
  if (item === null) return false;
  const list = item.parent;
  if (list === null) return false;
  let parentItem: MdNode | null = list.parent;
  while (parentItem !== null && parentItem.name !== "ListItem")
    parentItem = parentItem.parent;
  const previous = item.prevSibling;
  if (!removing && previous === null) return false;
  if (removing && parentItem === null) return false;
  const reference = removing ? parentItem : previous;
  if (reference === null) return false;
  const referenceLine = state.doc.lineAt(reference.from);
  const prefix = /^(\s*)(?:[-+*]|\d+[.)])\s+/.exec(referenceLine.text);
  if (prefix === null) return false;
  const width = prefix[0].length - (prefix[1]?.length ?? 0);
  const first = state.doc.lineAt(item.from);
  // An empty selection moves the whole item; a selection also includes the
  // remainder of the last selected item, including its nested children.
  let end = item.to;
  if (!range.empty) {
    let last: MdNode | null = nodeAt(state, Math.max(range.from, range.to - 1));
    while (last !== null) {
      if (last.name === "ListItem" && last.parent?.from === list.from) {
        end = last.to;
        break;
      }
      last = last.parent;
    }
    if (end < range.to) return false;
  }
  const lastLine = state.doc.lineAt(Math.max(item.from, end - 1));
  const changes: ChangeSpec[] = [];
  for (let number = first.number; number <= lastLine.number; number += 1) {
    const line = state.doc.line(number);
    const spaces = /^ */.exec(line.text)?.[0].length ?? 0;
    changes.push(
      removing
        ? { from: line.from, to: line.from + Math.min(width, spaces) }
        : { from: line.from, insert: " ".repeat(width) },
    );
  }
  const changeSet = state.changes(changes);
  return apply(target, changeSet, state.selection.map(changeSet));
}

export const indentMarkdown: StateCommand = (target) =>
  shiftList(target, false) || indentMore(target);
export const outdentMarkdown: StateCommand = (target) =>
  shiftList(target, true) || indentLess(target);

// Tab is structural only in lists and code. Elsewhere it keeps its normal
// keyboard-focus behavior; CodeMirror's Escape, Tab escape hatch still applies.
export const tabIndent: StateCommand = (target) => {
  if (target.state.readOnly) return false;
  if (shiftList(target, false)) return true;
  return (
    protectedRange(
      target.state,
      target.state.selection.main.from,
      target.state.selection.main.to,
    ) &&
    frontmatter(target.state) === undefined &&
    indentMore(target)
  );
};
export const tabOutdent: StateCommand = (target) => {
  if (target.state.readOnly) return false;
  if (shiftList(target, true)) return true;
  return (
    protectedRange(
      target.state,
      target.state.selection.main.from,
      target.state.selection.main.to,
    ) &&
    frontmatter(target.state) === undefined &&
    indentLess(target)
  );
};

export function insertBlock(kind: "code" | "table"): StateCommand {
  return (target) => {
    const { state } = target;
    const range = state.selection.main;
    if (
      state.selection.ranges.length !== 1 ||
      protectedRange(state, range.from, range.to)
    )
      return false;
    const text = state.sliceDoc(range.from, range.to);
    const before =
      state.doc.lineAt(range.from).from === range.from ? "" : "\n\n";
    const after = range.to === state.doc.length ? "" : "\n\n";
    const fence = "`".repeat(
      Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)),
    );
    const body =
      kind === "code"
        ? `${fence}\n${text}\n${fence}`
        : "| Column 1 | Column 2 |\n| --- | --- |\n|  |  |";
    // Tables insert beside selected prose; they never discard it.
    const preserved = kind === "table" && text !== "" ? text + "\n\n" : "";
    const insert = before + preserved + body + after;
    const from =
      range.from +
      before.length +
      preserved.length +
      (kind === "code" ? fence.length + 1 : 2);
    return apply(
      target,
      { from: range.from, to: range.to, insert },
      EditorSelection.single(
        from,
        from + (kind === "code" ? text.length : "Column 1".length),
      ),
    );
  };
}

export const authoringKeymap: readonly KeyBinding[] = [
  { key: "Mod-b", run: toggleBold, preventDefault: true },
  { key: "Mod-i", run: toggleItalic, preventDefault: true },
  { key: "Mod-k", run: insertLink, preventDefault: true },
  { key: "Mod-Shift-x", run: toggleStrike, preventDefault: true },
  { key: "Mod-Shift-c", run: toggleInlineCode, preventDefault: true },
  { key: "Mod-]", run: indentMarkdown, preventDefault: true },
  { key: "Mod-[", run: outdentMarkdown, preventDefault: true },
  { key: "Tab", run: tabIndent, shift: tabOutdent },
];
