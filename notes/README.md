# notes/

Engineering background: upgrade narratives, measurements, incident
write-ups, and evaluations of approaches that were considered and
rejected.

This is deliberately separate from `AGENTS.md`, which holds durable rules
and is loaded into every agent's context. Rules there, evidence here,
linked from the rule they explain.

It is also separate from `docs/`, which is user-facing product
documentation published to the Corpus site. Nothing here ships.

- `typegraph.md` — TypeGraph upgrades, the 0.50 schema-migration
  incident, why atomic-write releases don't speed Corpus up, diagnostics
  kept off the boot path.
- `toolchain.md` — why `pnpm lint` needs an 8 GiB heap, the TypeScript 7
  evaluation, dependency-update mechanics.
- `better-auth.md` — the Better Auth 1.7 bump and the workarounds it
  still requires.
- `files.md` — images and attachments: why files are graph nodes with bytes in
  R2, the bytes-first upload order and the orphan sweep that makes it safe, the
  SVG defenses, and what the first PR deliberately left for share links, the
  mirror, the CLI and MCP.
