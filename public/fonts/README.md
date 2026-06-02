# Fonts

Self-hosted **Geist** + **Geist Mono** (Vercel, OFL-1.1 — see `OFL.txt`),
the design system typeface (DESIGN.md). No Google Fonts CDN — consistent
with the no-external-dependency posture of the Workers bundle.

- `Geist-Variable.woff2` — variable upright (wght 100–900), `--font-sans`
- `GeistMono-Variable.woff2` — variable upright, `--font-mono`
- `OFL.txt` — the SIL Open Font License (redistribution requires it)

Wired in `src/styles.css` via Tailwind v4 `@font-face` + `@theme`. Only the
two variable upright webfonts are vendored on purpose: everything in
`public/` is served verbatim into the deployed Worker, so the full upstream
distribution (17 MB of ttf/otf/static weights/italics) is deliberately NOT
committed. To upgrade: download a new `geist-font` release, copy
`fonts/Geist/webfonts/Geist[wght].woff2` →`Geist-Variable.woff2` and
`fonts/GeistMono/webfonts/GeistMono[wght].woff2` → `GeistMono-Variable.woff2`,
refresh `OFL.txt`, and discard the rest.
