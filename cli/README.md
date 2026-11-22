# Corpus CLI

Install and configure the standalone CLI:

```sh
npm install --global @nicia-ai/corpus-cli
corpus setup
corpus doctor
corpus mcp add --client cursor
```

Requires Node.js 22 or newer.

The setup command defaults to `https://corpus.nicia.ai`, securely prompts once
for your `cck_…` API key, verifies the connection, and writes a private `0600`
config file on Unix. Self-hosters use `corpus setup --url URL`. Windows uses the
current user's ACLs. Environment
variables (`CORPUS_URL`, `CORPUS_API_KEY`) continue to override saved config
for CI.

`corpus pull --all` and `corpus push --all` carry a corpus's images and
attachments (PNG, JPEG, GIF, WebP, AVIF, SVG, PDF) along with its pages. That
needs version 0.2.0 or newer: an older CLI does not fail on a corpus with
images, it just never reads them. Upgrade with
`npm install --global @nicia-ai/corpus-cli@latest`.

See the full [CLI guide](https://github.com/nicia-ai/corpus/blob/main/docs/cli.md).
