import { describe, expect, it } from "vitest";

import {
  REVIEWER_NOTE_MAX_LENGTH,
  reviewerNoteSchema,
} from "../src/lib/reviewer-note";

describe("reviewer note boundary", () => {
  it("trims meaningful notes and omits whitespace-only notes", () => {
    expect(reviewerNoteSchema.parse("  Useful feedback. \n")).toBe(
      "Useful feedback.",
    );
    expect(reviewerNoteSchema.parse(" \n\t ")).toBeUndefined();
  });

  it("rejects notes over the durable contract limit", () => {
    expect(
      reviewerNoteSchema.safeParse("x".repeat(REVIEWER_NOTE_MAX_LENGTH + 1))
        .success,
    ).toBe(false);
  });
});
