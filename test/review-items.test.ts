import { describe, expect, it } from "vitest";

import {
  buildReviewModel,
  type InlineSuggestionMark,
  type ReviewItem,
} from "../src/lib/review-items";
import type { CommentThreadView } from "../src/lib/server/comments";
import type { SuggestionView } from "../src/lib/server/suggestions";
import type { AnchorBlock } from "../src/lib/text-anchor";

const blocks: readonly AnchorBlock[] = [
  { id: "b0", index: 0, text: "alpha lead", sourceStart: 0, sourceEnd: 10 },
  {
    id: "b1",
    index: 1,
    text: "beta middle",
    sourceStart: 12,
    sourceEnd: 23,
  },
  { id: "b2", index: 2, text: "gamma tail", sourceStart: 25, sourceEnd: 35 },
];

const comment = (
  id: number,
  blockId: string,
  start: number,
  status: CommentThreadView["status"] = "open",
): CommentThreadView => ({
  id,
  status,
  anchorBlockId: blockId,
  anchorStart: start,
  anchorEnd: start + 4,
  quote: { prefix: "", exact: "beta", suffix: "" },
  createdBy: "u1",
  createdAt: "2026-06-08T00:00:00Z",
  resolvedBy: undefined,
  resolvedAt: undefined,
  comments: [
    {
      id: id * 10,
      body: "please check",
      createdBy: "u1",
      createdAt: "2026-06-08T00:00:00Z",
    },
  ],
});

const suggestion = (
  id: number,
  hunk: SuggestionView["hunks"][number],
  baseDocVersion = 1,
): SuggestionView => ({
  id,
  status: "open",
  baseDocVersion,
  proposedMarkdown: "next",
  createdBy: "agent",
  channel: "mcp",
  createdAt: "2026-06-08T00:00:00Z",
  hunks: [hunk],
});

const hunk = (
  id: number,
  op: SuggestionView["hunks"][number]["op"],
  baseStart: number,
  baseEnd: number,
): SuggestionView["hunks"][number] => ({
  id,
  ordinal: id,
  op,
  baseStart,
  baseEnd,
  proposedText: op === "delete" ? "" : "replacement",
  decision: "pending",
});

const markIds = (marks: readonly InlineSuggestionMark[]): readonly string[] =>
  marks.map(
    (m) => `${m.op}:${m.anchor.blockId}:${m.anchor.start}:${m.anchor.end}`,
  );

function onlyComment(
  item: ReviewItem | undefined,
): Extract<ReviewItem, { kind: "comment" }> {
  expect(item?.kind).toBe("comment");
  if (item?.kind !== "comment") throw new Error("expected comment");
  return item;
}

describe("buildReviewModel", () => {
  it("interleaves comments and suggestions by document source position", () => {
    const model = buildReviewModel({
      blocks,
      threads: [comment(1, "b2", 0)],
      suggestions: [suggestion(2, hunk(20, "replace", 12, 23))],
      docVersion: 1,
    });

    expect(model.items.map((i) => i.id)).toEqual(["suggestion:2", "comment:1"]);
  });

  it("marks resolved comment anchors whose text is still present", () => {
    const model = buildReviewModel({
      blocks,
      threads: [comment(1, "b1", 0, "resolved")],
      suggestions: [],
      docVersion: 1,
    });

    const item = onlyComment(model.items[0]);
    expect(item.anchorEvidence).toEqual({
      status: "present",
      original: "beta",
    });
  });

  it("marks resolved comment anchors whose text changed at the anchor", () => {
    const model = buildReviewModel({
      blocks: [
        {
          id: "b1",
          index: 0,
          text: "zeta middle",
          sourceStart: 0,
          sourceEnd: 11,
        },
      ],
      threads: [comment(1, "b1", 0, "resolved")],
      suggestions: [],
      docVersion: 1,
    });

    const item = onlyComment(model.items[0]);
    expect(item.anchorEvidence).toEqual({
      status: "changed",
      original: "beta",
      current: "zeta middle",
    });
  });

  it("marks resolved comment anchors whose text was removed", () => {
    const model = buildReviewModel({
      blocks: [
        {
          id: "b0",
          index: 0,
          text: "alpha lead",
          sourceStart: 0,
          sourceEnd: 10,
        },
      ],
      threads: [comment(1, "missing", 0, "resolved")],
      suggestions: [],
      docVersion: 1,
    });

    const item = onlyComment(model.items[0]);
    expect(item.anchorEvidence).toEqual({
      status: "removed",
      original: "beta",
    });
  });

  it("creates inline marks for current-version replace and delete hunks", () => {
    const model = buildReviewModel({
      blocks,
      threads: [],
      suggestions: [
        suggestion(1, hunk(10, "replace", 12, 23)),
        suggestion(2, hunk(20, "delete", 25, 35)),
      ],
      docVersion: 1,
    });

    expect(markIds(model.inlineSuggestionMarks)).toEqual([
      "replace:b1:0:11",
      "delete:b2:0:10",
    ]);
  });

  it("anchors insertions to the nearest visible block seam", () => {
    const model = buildReviewModel({
      blocks,
      threads: [],
      suggestions: [suggestion(1, hunk(10, "insert", 23, 23))],
      docVersion: 1,
    });

    expect(markIds(model.inlineSuggestionMarks)).toEqual(["insert:b1:10:11"]);
  });

  it("does not mark stale suggestions against the current body", () => {
    const model = buildReviewModel({
      blocks,
      threads: [],
      suggestions: [suggestion(1, hunk(10, "replace", 12, 23), 0)],
      docVersion: 1,
    });

    expect(model.inlineSuggestionMarks).toEqual([]);
    expect(model.activeCount).toBe(0);
    expect(model.staleSuggestionCount).toBe(1);
  });

  it("fails closed when a hunk only partially covers a rendered block", () => {
    const model = buildReviewModel({
      blocks,
      threads: [],
      suggestions: [suggestion(1, hunk(10, "replace", 15, 18))],
      docVersion: 1,
    });

    expect(model.inlineSuggestionMarks).toEqual([]);
  });
});
