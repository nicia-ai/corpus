// MCP setup snippets shared by McpSetupPage. Server name is always
// `corpus-<slug>` so recipes stay in lockstep with Connect-this-corpus.

export function corpusServerName(corpusSlug: string): string {
  return `corpus-${corpusSlug}`;
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
