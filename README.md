# Corpus

**Corpus is a shared markdown library for agent context** — the
canonical place a team keeps the documents its AI agents reason over.
Your team writes the docs in a web UI (no Git, no markdown toolchain);
your agents read them live over **MCP**, always on the current, approved
version. Product specs, policies, runbooks, domain knowledge: versioned,
shared, and served as one source of truth, instead of stale prompt files
copied into every agent.

You already wrote these docs. The trouble is they're scattered across
repos, gists, Notion, and laptops, every agent carries its own drifting
copy, and no one can see the full set. Corpus is **not a prompt manager,
not a vector database, and not a RAG pipeline** — it's the documents you
already have, made shared and versioned. Non-engineers author and curate
them, group them into ordered **collections**, and agents consume those
collections over MCP with per-project OAuth/API-key isolation: an agent
only ever sees the project its credential resolves to.

Tenancy is **Organization → Project**: one default project is
materialized per organization (the project selector stays hidden until a
second exists). It runs entirely on Cloudflare — a Worker (Hono +
TanStack Start), a D1 control plane for identity, and one SQLite-backed
Durable Object per **project** holding that project's documents,
collections, and folders.

That document/collection/folder model is built on
**[TypeGraph](https://typegraph.dev)**, our open-source typed-graph
library — Corpus's sibling in the knowledge stack (TypeGraph for
structure, Corpus for context). Because documents are graph nodes shared
across collections by reference rather than copied, one edit updates
every collection, and every agent that reads it, at once. TypeGraph's
node-unique `(slug, docVersion)` constraint gives optimistic-concurrency
conflict detection for free: a racing save becomes a 409 conflict, never
a lost write. The same graph underpins the verifiable, append-only
version history.

## What it does

- **Documents** — markdown, edited in-browser, with an append-only
  version ledger and optimistic-concurrency conflict resolution (a
  side-by-side merge UI, never a lost write).
- **Collaboration** — a people-only review layer over documents:
  threaded **comments** anchored to text that follow it across edits and
  moves; **suggestions** reviewed and applied per hunk; live **presence**
  of who's viewing; and a verifiable **edit history** any version can be
  restored from. The full review layer stays off MCP and out of the bundle;
  an originating agent can only retrieve its own proposal's settled outcome.
- **Collections** — an ordered set of documents assembled into one
  corpus, with a token-size estimate so you can see when a collection is
  too large for an agent to use well.
- **MCP** — each project exposes an MCP endpoint (`/mcp`) authenticated
  by OAuth bearer token or `cck_`-prefixed API key. An agent only ever
  sees the Collection its credential is bound to. It reads documents and
  collections, and can **propose edits — and new documents** with
  `suggest_edit`: a reviewable suggestion a human accepts or rejects
  (per hunk for edits; create-then-attach for a proposed new document),
  never an auto-applied write. Agents propose; only humans approve. With
  `get_proposal_result`, the originating caller can retrieve the outcome,
  accepted hunks, resulting version, and optional reviewer note. Comments
  and unrelated suggestion state remain off-MCP.
- **CLI** — a Git-free `pull`/`push` tool (`pnpm corpus`) over a
  collection-scoped REST surface (`/api/v1/docs`), for editing documents
  from a terminal or CI with the same optimistic-concurrency contract as
  the editor. Its logic is a runtime-agnostic core (web `fetch` + an
  injected filesystem port, zero `node:` imports), so it also runs under
  Deno, Workers, or a WASM host. See [docs/cli.md](docs/cli.md).
- **Portable bundle** — export the whole project as a deterministic,
  content-addressed bundle (web UI → Settings → Export); re-import to
  the same hash on any Corpus instance.

## Run it locally

Prerequisites: Node 24 (the CI target), `pnpm` 10, and a Cloudflare
account for `wrangler`.

```bash
pnpm install

# Create the local D1 database and apply control-plane migrations.
# Required before the first signup (auth/tenancy tables live in D1).
pnpm db:migrate

pnpm dev          # Vite + Worker on http://localhost:8787
```

Then open http://localhost:8787, sign up, name your organization, add a
document, create a collection, and copy the MCP URL into your agent.

If `pnpm db:migrate` fails with `table account already exists`, your
local D1 state is stale. Remove `.wrangler/state/v3/d1` and run
`pnpm db:migrate` again.

Other commands:

| Command                                                        | What it does                                     |
| -------------------------------------------------------------- | ------------------------------------------------ |
| `pnpm build`                                                   | Production build (`vite build`)                  |
| `pnpm test`                                                    | Full suite — vitest-pool-workers, real DO + D1   |
| `pnpm typecheck`                                               | `wrangler types` then `tsc --noEmit`             |
| `pnpm lint` / `pnpm format`                                    | ESLint / Prettier                                |
| `pnpm auth:schema`                                             | Regenerate the Better Auth Drizzle schema        |
| `pnpm db:generate`                                             | Generate a new control-plane migration (Drizzle) |
| `pnpm db:generate:do` / `pnpm db:generate:event-log`           | Regenerate Durable Object ledger baselines       |
| `pnpm db:migrate` / `pnpm db:migrate:remote`                   | Apply D1 migrations (local / remote)             |
| `pnpm check:do-migrations` / `pnpm check:event-log-migrations` | Verify generated Durable Object migrations       |
| `pnpm deploy`                                                  | `wrangler deploy`                                |

## Folder structure

```
src/
  server.ts            Worker entry: routes API paths → Hono, else → TanStack Start
  api.ts               Hono app — external/non-UI surface (auth, MCP, discovery, health)
  auth.server.ts       Better Auth instance (email+password, JWT, OAuth provider)
  start.tsx router.tsx TanStack Start wiring
  routes/              File-based routes; data via loaders + server fns (no useEffect)
  lib/
    server/            Web data layer; `*.functions.ts` wrappers isolate `*.server.ts` implementations
    middleware.ts      Session / auth / project middleware
    server-context.ts  Injected Cloudflare-binding context + guard
  control/             Control plane (D1): identity, organizations, projects, membership
    project-resolution.ts  resolveProject (cached): projectId → ProjectStore lookup
    org-lifecycle.ts       Better Auth org-plugin seam (materializes the default project)
    store-for.ts           The storeFor() multi-tenant boundary
    db.ts env.ts env.server.ts schema/ auth.cli.ts
  project-store.ts     ProjectStore Durable Object — one per project
  event-log-store.ts   EventLogStore Durable Object — durable instrumentation event stream
  store/               Data-plane internals: handle, repos, domain
  db.ts                Drizzle ledger tables (co-located in the DO's SQLite)
  graph.ts             TypeGraph schema: Document + Collection + Folder
  mcp.ts               MCP JSON-RPC surface
  errors.ts util.ts
test/                  vitest-pool-workers suites (real bindings)
drizzle/               Generated D1 migrations (single clean baseline)
drizzle-do/            Generated ProjectStore ledger migrations
drizzle-event-log/     Generated EventLogStore migrations
```

The split is deliberate: **control plane** (D1, central identity) vs.
**data plane** (per-project `ProjectStore` SQLite). The single mapping
between them is `storeFor(env, projectId)` in
`src/control/store-for.ts` — the multi-tenant boundary. See `AGENTS.md`
for full architecture guidance.

## Environment variables

Set in `wrangler.jsonc` `vars` for dev; in production set secrets with
`wrangler secret put`. Optional local secrets (the Google credentials
below) go in `.dev.vars` — copy `.dev.vars.example` to get started.

| Variable               | Required | Notes                                                                                                                                                                          |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BETTER_AUTH_SECRET`   | Yes      | ≥32 chars. The committed dev value is a placeholder — set a real secret via `wrangler secret put BETTER_AUTH_SECRET` for any deployed environment.                             |
| `BETTER_AUTH_URL`      | Prod     | Public base URL. Defaults to `http://localhost:8787`, so it's optional for local dev; set it for any deployed environment.                                                     |
| `GOOGLE_CLIENT_ID`     | No       | Google OAuth client id. Set **both** Google vars to add "Continue with Google" to sign-in/sign-up; unset keeps email/password only.                                            |
| `GOOGLE_CLIENT_SECRET` | No       | Google OAuth client secret. Redirect URI is `<BETTER_AUTH_URL>/api/auth/callback/google`.                                                                                      |
| `EMAIL_PROVIDER`       | No       | Optional invite-email provider selector: `cloudflare` or `resend`. Unset auto-detects the Cloudflare binding first, then Resend; missing email config keeps copy-link invites. |
| `EMAIL_FROM`           | No       | Verified sender address for invite emails, for example `Corpus <noreply@example.com>`. Required only when enabling outbound email.                                             |
| `RESEND_API_KEY`       | No       | Resend API key for invite emails. Set with `EMAIL_FROM`; set `EMAIL_PROVIDER=resend` when Cloudflare email is also configured.                                                 |

Bindings (in `wrangler.jsonc`, not env vars):

- `PROJECT_STORE` — Durable Object namespace (`ProjectStore`), one instance per project.
- `EVENT_LOG_STORE` — Durable Object namespace (`EventLogStore`), one instance per project for the append-only event stream.
- `DB` — D1 database for the control plane. Before deploying remotely,
  run `wrangler d1 create corpus-control` and replace the
  `database_id` placeholder in `wrangler.jsonc`.
- Optional `EMAIL` — Cloudflare Email Service `send_email` binding for
  invite emails. Configure it as a binding named `EMAIL` with
  `EMAIL_FROM`; if it is absent, Corpus can use Resend or copy-link
  fallback.

## Self-hosting

Run `pnpm db:migrate` **before the first signup** — the auth/tenancy
tables live in D1 and signup fails without them.

Deploy behind your own domain. Prefer an `app.<your-domain>` host (e.g.
`app.example.com`) and set `BETTER_AUTH_URL` to it — a dedicated
subdomain gives clean cookie/domain scoping for Better Auth. Set
`BETTER_AUTH_SECRET` with `wrangler secret put BETTER_AUTH_SECRET`.

**Single-tenant or multi-tenant is your call — no feature is withheld.**
This is the whole product: multi-tenancy (Organization → Project),
versioning, the portable bundle, MCP, and team management all ship here
under Apache-2.0. There is no `ee/` directory, no license key, and no
gated edition. Bundle export is unconditional — you can always get your
data out.

The Cloudflare cron in `wrangler.jsonc` runs an hourly retention sweep
(`scheduled` in `src/server.ts`) that GCs expired control-plane auth rows
and applies each project's retention policy. You inherit it by default;
adjust the schedule to taste. Note the sweep bounds _dead_ rows, not the
_issuance_ rate: an instance exposing public MCP without an upstream
rate limit can still accumulate auth rows between sweeps faster than an
hourly `LIMIT`-loop reclaims them. Real abuse-rate limiting is a hosted
concern, exposed in OSS as the unlimited-by-default entitlements port
(`src/control/entitlements.ts`).

## License

[Apache-2.0](LICENSE). Patent grant included; no CLA required to
contribute (see `CONTRIBUTING.md`). The names "Corpus" and "Nicia" are
reserved trademarks and are not licensed by Apache-2.0.
