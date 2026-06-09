# Enterprise AI Coding Policy Brief Demo

This directory is a self-contained prompt packet for recording a Corpus demo
with local Claude Code agents.

The demo story: a human editor owns a shared policy brief in Corpus while two
local Claude Code agents research separate angles and propose reviewable edits
over MCP. The human accepts, rejects, and applies the useful hunks.

## Corpus Setup

1. Start Corpus locally or use a staging project.
2. Create a Collection named `Leadership Briefing`.
3. Create a document from `brief-seed.md`.
4. Add the document to the Collection.
5. Open the document in Corpus review mode before starting the agents.
6. Connect Claude Code to the Collection's MCP endpoint.

For a clean recording, use two Claude Code terminals side by side or stacked
offscreen. Paste one prompt into each terminal, then return focus to Corpus.

## Suggested Recording Order

1. Show the brief in Corpus with the review rail visible.
2. In terminal one, paste `prompts/01-market-research-agent.md`.
3. In terminal two, paste `prompts/02-risk-policy-agent.md`.
4. Return to the Corpus document.
5. Let the MCP suggestion toast appear.
6. Review the first suggestion, accept one hunk and reject one if available.
7. Let the second suggestion appear.
8. Apply the accepted changes.
9. Optionally run `prompts/03-editor-agent.md` for a final tightening pass.

## Prompt Rules

Each agent prompt tells Claude Code to:

- Use Corpus MCP tools, not local file edits.
- Read the current document before proposing.
- Use `suggest_edit` only after producing the full replacement markdown.
- Keep the change focused so the review rail stays readable on camera.
- Treat the human as the final approver.

The source packets in `sources/` keep the run realistic without depending on
live web research timing.
