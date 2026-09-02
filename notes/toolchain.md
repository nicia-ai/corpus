# Toolchain notes

Background for the verification-gate rules in `AGENTS.md`.

## Why `pnpm lint` needs an 8 GiB heap

Both `lint` scripts set `NODE_OPTIONS=--max-old-space-size=8192`. This is
load-bearing, not cargo cult: type-aware linting over
`tsconfig.eslint.json` needs ~7 GiB, and Node's default heap dies partway
through with a V8 stack trace rather than a lint error. Measured on this
tree: 6144 OOMs, 8192 completes at ~7.8 GiB peak.

The cost is type-aware linting itself, not this repo's types — `tsc` over
the _same_ project peaks at 1.3 GiB in 5s. Type-aware rules query the
checker per node, so the checker's caches grow monotonically across files
and are never released: any single directory lints in ~1.3 GiB, the whole
tree needs ~7.8.

Measured and ruled out, so nobody re-tries them:

- switching to `projectService` — same ceiling, ~2x faster
- disabling the most expensive rule, `no-deprecated` — no change

The real lever is linting fewer files type-aware, not a bigger heap.

## TypeScript 7 — evaluated 2026-09-01, rejected

TS 7.0.2 typechecks this tree correctly and fast: `src` in 1.1s (vs 5s),
`tsconfig.test.json` in 1.0s, and `cli/` emits JS + declarations fine. No
source changes were needed.

typescript-eslint hard-refuses it. `@typescript-eslint/eslint-plugin`
throws "typescript-eslint does not support TS 7.0" at require time, and
its peer range is `>=4.8.4 <6.1.0`. No released version supports TS 7
(8.69.0 is latest; TS >=7.1 support is tracked in typescript-eslint#10940),
so `pnpm lint` does not run at all.

The documented side-by-side workaround — keep TS 6 installed for the
eslint API — is not worth taking. It leaves `pnpm lint`, the ~7.8 GiB
step above, running on the TS 6 checker exactly as now, and buys ~4s of
`tsc` on a gate whose test suite runs ~190s.

Revisit when typescript-eslint ships TS 7 support, so the whole toolchain
moves at once — that is also the release that could actually move the
lint ceiling.

## Dependency updates

`pnpm` (v11) enforces a minimum release age; fresh releases are held back
until they age past it. `pnpm add <pkg>@<version>` records an override in
`minimumReleaseAgeExclude` in `pnpm-workspace.yaml` automatically.

That list accumulates cruft: pnpm merges successive pins into
`1.54.2 || 1.54.3` unions and never drops the stale half, and appends new
entries out of sort order. When bumping, prune entries whose versions are
no longer in `pnpm-lock.yaml` and re-sort, so the list keeps describing
what is actually installed.
