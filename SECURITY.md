# Security Policy

## Reporting a vulnerability

If you believe you have found a security issue in Corpus, **please do
not file a public GitHub issue.** Email <security@nicia.ai> with:

- a description of the issue and its impact,
- steps to reproduce (a minimal proof-of-concept is welcome),
- the affected version, commit SHA, or deployed URL,
- whether the issue is already public anywhere.

We aim to acknowledge new reports within 3 business days and to agree a
fix and coordinated-disclosure timeline with you. We will credit
reporters who want credit in the release notes.

## Scope

In scope: the code in this repository — the Worker entrypoint, the
`ProjectStore` Durable Object, the control-plane D1 schema, the MCP
surface (`/mcp`), the Better Auth / OAuth flows, the API-key (`cck_`)
machinery, and the TanStack Start routes.

Out of scope: vulnerabilities in upstream dependencies (please report
those upstream — we will pick up the fix on the next release),
denial-of-service requiring unreasonable resources, social-engineering
attacks, and findings only reproducible against a third-party-operated
deployment you do not own.

## Supported versions

Corpus is pre-1.0. Only the latest release on `main` receives security
fixes; please update before reporting.

## Hardening guidance

If you self-host Corpus, the most important operational controls are:

- Set `BETTER_AUTH_SECRET` via `wrangler secret put` in production
  (the value in `wrangler.jsonc` is a development placeholder).
- Treat `cck_`-prefixed API keys as bearer credentials: rotate on
  suspected compromise (the Connections page is the rotation surface).
- Restrict Cloudflare account access; the Worker runs with full DO and
  D1 binding authority.
