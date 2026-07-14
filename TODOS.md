# TODOS

Deferred work, captured during `/plan-eng-review` of the agent-as-suggester
wedge (2026-06-07). Each item has enough context to pick up cold.

## Rate-limit / entitlement on agent MCP writes

- **What:** Throttle or entitlement-gate `suggest_edit` so a connected agent
  can't spam suggestions. Each call opens a `ProjectStore.write()` transaction
  and a `broadcastChanged()` — a loop would amplify writes and presence churn.
- **Why:** `suggest_edit` is the first MCP capability that opens a write tx.
  Reads were free; this isn't. Abuse surface is real once the endpoint is public.
- **Where to start:** `src/entitlements.ts` already imports `McpExecutor` — add
  a per-`callerRef` rate check at the suggest seam. Decide the budget (per
  minute / per doc) and the over-limit JSON-RPC error.
- **Depends on:** the suggest_edit write path landing first.
- **Blocks:** public launch. NOT the 3-5 person private beta.

## Email notification on agent suggestion

- **What:** Email a document's collection members when an agent files a
  suggestion, so an absent human learns without reopening the tab.
- **Why:** The presence WebSocket only nudges _connected_ clients
  (`broadcastChanged`). The per-doc pending count covers in-app; email
  covers the absent human — needed for a real product, not for the beta.
- **Where to start:** The transport already exists — `sendEmail` in
  `src/control/email.ts` (Cloudflare Email Service or Resend, selected by
  `EMAIL_PROVIDER`/`EMAIL_FROM`/`RESEND_API_KEY` in `src/control/env.ts`),
  already used fail-soft by invite sending in `src/lib/server/team.ts`.
  Remaining work is the feature itself: member-address lookup via the
  control DB, a recipient policy (all org members? owners?), and a hook at
  the suggestion write's transport seam (the `/mcp` path in `src/api.ts`
  has `env`; the DO does not send email).
- **Depends on:** per-doc count surface (shipped); recipient policy.
- **Blocks:** public launch.

## Zod-retrofit the existing MCP read tools

- **What:** Give `read_document`, `read_collection`, `read_document_meta`,
  `verify_history` real Zod input schemas, replacing ad-hoc `strField`
  (`src/mcp/params.ts:14`) and the stub `inputSchema: { type: "object" }`
  (`src/mcp/tools.ts:93`).
- **Why:** AGENTS.md mandates "Zod at MCP ingestion." The new `suggest_edit`
  tool follows it; the reads predate the rule and are inconsistent.
- **Where to start:** Define per-tool arg schemas in `src/mcp/` and parse in the
  handlers; surface the schemas in `toolsListResponse` so agents get real
  `inputSchema` hints.
- **Depends on:** nothing. Independent cleanup.
- **Blocks:** nothing.

## Approach B — two-way co-authoring loop

- **What:** Agent reads open comments/suggestions over MCP and responds/revises
  (not just proposes). The full human↔agent loop.
- **Why:** The north star ("humans and agents author markdown together"). But it
  builds the whole collab surface onto MCP — only justified once a user is hooked
  on one-way agent-suggest (design doc P4).
- **Where to start:** Widen the `McpExecutor` port with comment/suggestion reads
  - an agent reply path; design the agent-facing thread model.
- **Depends on:** behavioral demand from the agent-as-suggester beta.
- **Blocks:** nothing. Explicitly post-validation.
