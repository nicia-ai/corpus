import { EditorState } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import {
  InsertMarkWidget,
  liveReview,
  type ReviewMark,
  reviewDecorationsField,
  setReviewMarks,
} from "@/components/markdown/live-review";

// The marks → decorations mapping is a StateField, so it is exercised on a real
// EditorState without a live view (coords/layout need a DOM and are not tested
// here). We dispatch the marks effect and read the decoration set directly.

type DecoEntry = Readonly<{
  from: number;
  to: number;
  cls: string | undefined;
  widget: unknown;
}>;

function entries(set: DecorationSet): DecoEntry[] {
  const out: DecoEntry[] = [];
  const it = set.iter();
  while (it.value) {
    const spec = it.value.spec as Readonly<{
      class?: string;
      widget?: unknown;
    }>;
    out.push({
      from: it.from,
      to: it.to,
      cls: spec.class,
      widget: spec.widget,
    });
    it.next();
  }
  return out;
}

const noop = (): void => undefined;

function decorate(doc: string, marks: readonly ReviewMark[]): DecoEntry[] {
  const base = EditorState.create({
    doc,
    extensions: [liveReview({ onSelect: noop, onLayout: noop })],
  });
  const state = base.update({ effects: setReviewMarks.of(marks) }).state;
  return entries(state.field(reviewDecorationsField));
}

describe("review decorations", () => {
  it("paints a comment range", () => {
    expect(
      decorate("hello world", [
        { id: "comment:1", kind: "comment", from: 0, to: 5 },
      ]),
    ).toEqual([{ from: 0, to: 5, cls: "cm-md-comment" }]);
  });

  it("paints suggestion replace/delete ranges with op-specific classes", () => {
    expect(
      decorate("alpha beta gamma", [
        { id: "suggestion:1", kind: "replace", from: 0, to: 5 },
        { id: "suggestion:2", kind: "delete", from: 6, to: 10 },
      ]),
    ).toEqual([
      { from: 0, to: 5, cls: "cm-md-suggest-replace" },
      { from: 6, to: 10, cls: "cm-md-suggest-delete" },
    ]);
  });

  it("paints a zero-width insert marker widget at the seam", () => {
    const result = decorate("alpha beta", [
      { id: "suggestion:3", kind: "insert", from: 5, to: 5 },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.from).toBe(5);
    expect(result[0]?.to).toBe(5);
    expect(result[0]?.widget).toBeInstanceOf(InsertMarkWidget);
  });

  it("clamps out-of-range marks to the document", () => {
    expect(
      decorate("short", [
        { id: "comment:9", kind: "comment", from: 2, to: 999 },
      ]),
    ).toEqual([{ from: 2, to: 5, cls: "cm-md-comment" }]);
  });

  it("starts empty before any marks are set", () => {
    const state = EditorState.create({
      doc: "no marks yet",
      extensions: [liveReview({ onSelect: noop, onLayout: noop })],
    });
    expect(entries(state.field(reviewDecorationsField))).toEqual([]);
  });

  it("paints initial marks in the first editor state", () => {
    const state = EditorState.create({
      doc: "hello world",
      extensions: [
        liveReview({
          onSelect: noop,
          onLayout: noop,
          initialMarks: [{ id: "comment:1", kind: "comment", from: 0, to: 5 }],
        }),
      ],
    });

    expect(entries(state.field(reviewDecorationsField))).toEqual([
      { from: 0, to: 5, cls: "cm-md-comment" },
    ]);
  });
});
