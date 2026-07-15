# Corpus CLI

Install and configure the standalone CLI:

```sh
npm install --global @nicia-ai/corpus-cli
corpus setup
corpus doctor
```

Requires Node.js 22 or newer.

The setup command securely prompts for your Corpus URL and `cck_…` API key,
verifies the connection, and writes a private `0600` config file on Unix.
Windows uses the current user's ACLs. Environment
variables (`CORPUS_URL`, `CORPUS_API_KEY`) continue to override saved config
for CI.

See the full [CLI guide](https://github.com/nicia-ai/corpus/blob/main/docs/cli.md).
