// Onboarding + setup snippets for connecting an agent to a corpus and
// having it propose the first document. Server name is always
// `corpus-<slug>` so GetStarted and McpSetupPage stay in lockstep.

export function corpusServerName(corpusSlug: string): string {
  return `corpus-${corpusSlug}`;
}

export function buildAgentWritePrompt(serverName: string): string {
  return `## Corpus — write the first document

You are connected to the team's Corpus over MCP as \`${serverName}\`.

Your task: propose one useful document for this corpus.

1. Call \`read_collection\` on \`${serverName}\` to see what's in scope.
2. Choose a slug and write a complete markdown document the team needs (policy, FAQ, overview, runbook, etc.).
3. Call \`suggest_edit\` with:
   - \`slug\`: your chosen identifier (e.g. \`getting-started\`)
   - \`baseDocVersion\`: \`0\` (this is a new document)
   - \`proposedMarkdown\`: the full body

Nothing is published until a human approves the proposal in Corpus. After you submit, tell the human to check Review.`;
}

export function cursorMcpSnippet(url: string, serverName: string): string {
  return `{
  "mcpServers": {
    "${serverName}": {
      "url": "${url}"
    }
  }
}`;
}

export function claudeCodeMcpCommand(url: string, serverName: string): string {
  return `claude mcp add \\
  --transport http \\
  ${serverName} \\
  ${url}`;
}

export function vscodeMcpSnippet(url: string, serverName: string): string {
  return `{
  "servers": {
    "${serverName}": {
      "type": "http",
      "url": "${url}"
    }
  }
}`;
}

export function corpusCliMcpAddCommand(
  url: string,
  serverName: string,
  client: "cursor" | "claude-code" | "vscode" = "cursor",
): string {
  return `corpus mcp add --client ${client} --url ${url} --name ${serverName}`;
}
