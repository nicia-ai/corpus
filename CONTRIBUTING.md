# Contributing

Thanks for your interest. This project is licensed under **Apache-2.0**
(see `LICENSE`). By submitting a contribution you agree it is provided
under those terms (Apache-2.0 §5). No CLA is required.

## Developer Certificate of Origin (provenance)

We ask for a [DCO](https://developercertificate.org/) sign-off on commits
for contribution provenance. Add a `Signed-off-by` trailer:

```bash
git commit -s -m "your message"
```

This is lightweight hygiene, not a copyright assignment. It is optional
today and not load-bearing; if a sign-off is missing we will ask rather
than reject outright.

## Verification gate

One command runs the whole gate — the same one CI runs:

```bash
pnpm check         # typecheck, lint, format:check, migration checks, test, build
```

It must exit 0 before review. To auto-fix formatting and lint first and
then run the gate, use:

```bash
pnpm check:fix     # prettier --write + eslint --fix, then `pnpm check`
```

`pnpm check` is read-only (it verifies, never mutates), so CI and your
local run are identical. The gate is defined once in `package.json`;
`.github/workflows/ci.yml` just calls `pnpm check`.

## Generated schemas and migrations

Do not hand-edit generated schema or migration output. Run the matching
generator and commit the generated files:

- Better Auth schema-affecting changes: `pnpm auth:schema`, then
  `pnpm db:generate`.
- Control-plane schema changes in `src/control/schema/app.ts`:
  `pnpm db:generate`.
- Durable Object ledger changes in `src/db.ts`: `pnpm db:generate:do`,
  then `pnpm check:do-migrations`.
- Event log ledger changes in `src/event-log-db.ts`:
  `pnpm db:generate:event-log`, then
  `pnpm check:event-log-migrations`.

## Scope and conventions

- Read `AGENTS.md` first — it is the single source of truth for
  architecture, the control-plane / data-plane split, the data-plane
  layering rules, and the TypeScript conventions ESLint enforces.
- Keep changes within their layer. Validation stays at the transport
  edge; the atomic multi-store write stays visible in the Durable Object.
- New application errors extend `AppError` with a `kind` from the
  taxonomy in `src/errors.ts`.

## Trademarks

The names **"Corpus"** and **"Nicia"** are reserved and are not licensed
by Apache-2.0 (a license is not a trademark grant). You may state
factually that your work is built on or derived from this project; do not
use the reserved names in a way that implies endorsement or origin.
