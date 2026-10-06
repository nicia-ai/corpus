import { history, redo, undo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  EditorSelection,
  EditorState,
  Compartment,
  type StateCommand,
} from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";

import {
  authoringKeymap,
  indentMarkdown,
  insertBlock,
  insertLink,
  outdentMarkdown,
  setBlockStyle,
  tabIndent,
  tabOutdent,
  toggleBold,
  toggleInlineCode,
  toggleItalic,
  toggleStrike,
} from "@/components/markdown/authoring-commands";
import { livePreviewField } from "@/components/markdown/live-preview";
import {
  liveReview,
  reviewDecorationsField,
} from "@/components/markdown/live-review";
import { editorPresentation } from "@/components/markdown/MarkdownEditor";

function editor(doc: string, anchor = 0, head = anchor, readOnly = false) {
  let state = EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: [
      markdown({ base: markdownLanguage }),
      history(),
      EditorState.readOnly.of(readOnly),
    ],
  });
  return {
    get state() {
      return state;
    },
    run(command: StateCommand): boolean {
      return command({
        state,
        dispatch: (tr) => {
          state = tr.state;
        },
      });
    },
    select(anchor: number, head = anchor): void {
      state = state.update({
        selection: EditorSelection.single(anchor, head),
      }).state;
    },
    text(): string {
      return state.doc.toString();
    },
    selected(): string {
      return state.sliceDoc(state.selection.main.from, state.selection.main.to);
    },
  };
}

describe("Markdown authoring: formatting and links", () => {
  it("preserves surrounding bytes and reversed selections, and toggles formatting", () => {
    const cm = editor("Before text after", 11, 7);
    expect(cm.run(toggleBold)).toBe(true);
    expect(cm.text()).toBe("Before **text** after");
    expect(cm.selected()).toBe("text");
    expect(cm.state.selection.main.anchor).toBeGreaterThan(
      cm.state.selection.main.head,
    );
    cm.run(toggleBold);
    expect(cm.text()).toBe("Before text after");
    expect(cm.selected()).toBe("text");
  });

  it.each([
    [toggleBold, "**"],
    [toggleItalic, "*"],
    [toggleStrike, "~~"],
    [toggleInlineCode, "`"],
  ])(
    "inserts an empty formatting span with the caret inside",
    (command, delimiter) => {
      const cm = editor("hello", 5);
      cm.run(command);
      expect(cm.text()).toBe("hello" + delimiter + delimiter);
      expect(cm.state.selection.main.head).toBe(5 + delimiter.length);
    },
  );

  it("keeps surrounding whitespace outside emphasis", () => {
    const cm = editor("  text  ", 0, 8);
    cm.run(toggleItalic);
    expect(cm.text()).toBe("  *text*  ");
    expect(cm.selected()).toBe("text");
  });

  it("toggles a span off from a caret without moving the caret's text position", () => {
    const cm = editor("**hello**", 4);
    cm.run(toggleBold);
    expect(cm.text()).toBe("hello");
    expect(cm.state.selection.main.head).toBe(2);
  });

  it("uses a longer code delimiter around text containing backticks", () => {
    const cm = editor("a ` b", 0, 5);
    cm.run(toggleInlineCode);
    expect(cm.text()).toBe("``a ` b``");
    expect(cm.selected()).toBe("a ` b");
    cm.run(toggleInlineCode);
    expect(cm.text()).toBe("a ` b");
  });

  it("does not apply prose formatting inside code or metadata", () => {
    for (const [doc, pos] of [
      ["```md\nhello\n```", 8],
      ["---\ntitle: hello\n---\n\nbody", 12],
      ["`hello`", 3],
    ] as const) {
      const cm = editor(doc, pos);
      expect(cm.run(toggleBold)).toBe(false);
      expect(cm.text()).toBe(doc);
    }
  });

  it("selects a link destination when a label was selected", () => {
    const cm = editor("some text", 5, 9);
    cm.run(insertLink);
    expect(cm.text()).toBe("some [text](https://)");
    expect(cm.selected()).toBe("https://");
  });

  it("selects the label placeholder when inserting at a caret", () => {
    const cm = editor("", 0);
    cm.run(insertLink);
    expect(cm.selected()).toBe("link text");
  });

  it("edits an existing link instead of nesting links", () => {
    const cm = editor("[label](https://example.com)", 3);
    cm.run(insertLink);
    expect(cm.selected()).toBe("https://example.com");
    expect(cm.text()).toBe("[label](https://example.com)");
  });

  it("makes each formatting command a separate undo event", () => {
    const cm = editor("text", 0, 4);
    cm.run(toggleBold);
    cm.run(toggleItalic);
    expect(cm.text()).toBe("***text***");
    cm.run(undo);
    expect(cm.text()).toBe("**text**");
    cm.run(undo);
    expect(cm.text()).toBe("text");
    cm.run(redo);
    expect(cm.text()).toBe("**text**");
  });
});

describe("Markdown authoring: blocks and indentation", () => {
  it("transforms selected lines and excludes an unselected line at the range end", () => {
    const cm = editor("one\ntwo\nthree", 0, 8);
    cm.run(setBlockStyle("ordered"));
    expect(cm.text()).toBe("1. one\n2. two\nthree");
  });

  it("changes list types without losing task text or indentation", () => {
    const cm = editor("  - [x] done", 8);
    cm.run(setBlockStyle("quote"));
    expect(cm.text()).toBe("  > done");
    cm.run(setBlockStyle("paragraph"));
    expect(cm.text()).toBe("  done");
  });

  it("does not convert selected code or metadata into prose blocks", () => {
    const cm = editor("before\n```\ncode\n```\nafter", 0, 25);
    expect(cm.run(setBlockStyle("heading"))).toBe(false);
    expect(cm.text()).toBe("before\n```\ncode\n```\nafter");
  });

  it("nests an item and its children, retaining its caret", () => {
    const cm = editor("- first\n- second\n  - child", 12);
    expect(cm.run(tabIndent)).toBe(true);
    expect(cm.text()).toBe("- first\n  - second\n    - child");
    expect(cm.state.selection.main.head).toBe(14);
    expect(cm.run(tabOutdent)).toBe(true);
    expect(cm.text()).toBe("- first\n- second\n  - child");
  });

  it("uses the content column of multi-digit ordered markers", () => {
    const cm = editor("10. first\n11. second", 15);
    cm.run(indentMarkdown);
    expect(cm.text()).toBe("10. first\n    11. second");
    cm.run(outdentMarkdown);
    expect(cm.text()).toBe("10. first\n11. second");
  });

  it("moves multiple selected siblings with their children", () => {
    const cm = editor("- a\n- b\n- c\n  - d", 4, 11);
    cm.run(tabIndent);
    expect(cm.text()).toBe("- a\n  - b\n  - c\n    - d");
  });

  it("leaves Tab available for focus navigation outside structural editing", () => {
    const cm = editor("ordinary prose", 5);
    expect(cm.run(tabIndent)).toBe(false);
    expect(cm.run(tabOutdent)).toBe(false);
    expect(cm.text()).toBe("ordinary prose");
  });

  it("does not nest a first item or lift a top-level item with Tab", () => {
    const cm = editor("- first", 4);
    expect(cm.run(tabIndent)).toBe(false);
    expect(cm.run(tabOutdent)).toBe(false);
  });

  it("inserts a code fence longer than any fence in selected source", () => {
    const cm = editor("example ``` value", 0, 17);
    cm.run(insertBlock("code"));
    expect(cm.text()).toBe("````\nexample ``` value\n````");
    expect(cm.selected()).toBe("example ``` value");
  });

  it("inserts a table without discarding selected text", () => {
    const cm = editor("keep me", 0, 7);
    cm.run(insertBlock("table"));
    expect(cm.text()).toContain("keep me\n\n| Column 1 | Column 2 |");
    expect(cm.selected()).toBe("Column 1");
    cm.run(undo);
    expect(cm.text()).toBe("keep me");
  });
});

describe("Markdown authoring: integration contracts", () => {
  it("switches presentation without rewriting source or losing selection and undo", () => {
    const presentation = new Compartment();
    let state = EditorState.create({
      doc: "text",
      selection: EditorSelection.single(0, 4),
      extensions: [
        markdown({ base: markdownLanguage }),
        history(),
        presentation.of(editorPresentation(false)),
      ],
    });
    toggleBold({
      state,
      dispatch: (tr) => {
        state = tr.state;
      },
    });
    const selection = state.selection;
    const doc = state.doc;
    state = state.update({
      effects: presentation.reconfigure(editorPresentation(true)),
    }).state;
    expect(state.doc).toBe(doc);
    expect(state.selection.eq(selection)).toBe(true);
    expect(state.field(livePreviewField, false)).toBeUndefined();
    state = state.update({
      effects: presentation.reconfigure(editorPresentation(false)),
    }).state;
    expect(state.doc).toBe(doc);
    expect(state.field(livePreviewField, false)).toBeDefined();
    undo({
      state,
      dispatch: (tr) => {
        state = tr.state;
      },
    });
    expect(state.doc.toString()).toBe("text");
  });
  it("does not change a read-only document", () => {
    for (const command of [
      toggleBold,
      insertLink,
      setBlockStyle("heading"),
      insertBlock("table"),
      tabIndent,
      tabOutdent,
    ]) {
      const cm = editor("hello", 0, 5, true);
      expect(cm.run(command)).toBe(false);
      expect(cm.text()).toBe("hello");
    }
  });

  it("claims familiar prose shortcuts before CodeMirror's code-editor defaults", () => {
    expect(authoringKeymap.find((key) => key.key === "Mod-i")?.run).toBe(
      toggleItalic,
    );
    expect(authoringKeymap.find((key) => key.key === "Mod-b")?.run).toBe(
      toggleBold,
    );
  });

  it("maps existing review decorations through formatting transactions", () => {
    let state = EditorState.create({
      doc: "before text after",
      selection: EditorSelection.single(7, 11),
      extensions: [
        markdown({ base: markdownLanguage }),
        liveReview({
          onSelect: vi.fn(),
          onLayout: vi.fn(),
          initialMarks: [
            { id: "comment:1", kind: "comment", from: 12, to: 17 },
          ],
        }),
      ],
    });
    toggleBold({
      state,
      dispatch: (tr) => {
        state = tr.state;
      },
    });
    const mark = state.field(reviewDecorationsField).iter();
    expect(mark.from).toBe(16);
    expect(mark.to).toBe(21);
    expect(state.sliceDoc(mark.from, mark.to)).toBe("after");
  });
});
