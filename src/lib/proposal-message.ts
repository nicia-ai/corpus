import { z } from "zod";

export const PROPOSAL_MESSAGE_MAX_LENGTH = 2000;

// Shared web/MCP trust-boundary rule. Proposal messages are durable review
// records, so normalize incidental surrounding whitespace and reject empty or
// unbounded bodies before they reach the ProjectStore command.
export const proposalMessageSchema = z
  .string()
  .trim()
  .min(1)
  .max(PROPOSAL_MESSAGE_MAX_LENGTH);
