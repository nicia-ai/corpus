import { z } from "zod";

export const REVIEWER_NOTE_MAX_LENGTH = 2000;

// Shared trust-boundary rule for optional human outcome notes. Normalizing
// here keeps every decision path from persisting whitespace-only feedback.
export const reviewerNoteSchema = z
  .string()
  .max(REVIEWER_NOTE_MAX_LENGTH)
  .transform((note) => {
    const trimmed = note.trim();
    return trimmed === "" ? undefined : trimmed;
  });
