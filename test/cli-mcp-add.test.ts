import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { mcpAdd } from "../cli/mcp-add";

describe("corpus mcp add", () => {
  it("writes Cursor mcp.json with a mergeable server entry", async () => {
    const home = await mkdtemp(join(tmpdir(), "corpus-mcp-"));
    try {
      const r = await mcpAdd(
        [
          "--client",
          "cursor",
          "--url",
          "https://example.test",
          "--name",
          "corpus-default",
        ],
        { home, cwd: home },
      );
      expect(r.path).toBe(join(home, ".cursor", "mcp.json"));
      const written = r.path;
      if (written === undefined) throw new Error("expected path");
      const raw = JSON.parse(await readFile(written, "utf8")) as {
        mcpServers: Record<string, { url: string }>;
      };
      expect(raw.mcpServers["corpus-default"]?.url).toBe(
        "https://example.test/mcp",
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("prints a Claude Code command instead of writing a file", async () => {
    const home = await mkdtemp(join(tmpdir(), "corpus-mcp-"));
    try {
      const r = await mcpAdd(
        ["--client", "claude-code", "--name", "corpus-hr"],
        {
          home,
          cwd: home,
          corpusUrl: "https://corpus.example",
        },
      );
      expect(r.path).toBeUndefined();
      expect(r.command).toBe(
        "claude mcp add --transport http corpus-hr https://corpus.example/mcp",
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("writes VS Code .vscode/mcp.json in the working directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "corpus-mcp-"));
    try {
      const r = await mcpAdd(
        [
          "--client",
          "vscode",
          "--url",
          "https://corpus.example/mcp",
          "--name",
          "corpus-ops",
        ],
        { home: root, cwd: root },
      );
      expect(r.path).toBe(join(root, ".vscode", "mcp.json"));
      const written = r.path;
      if (written === undefined) throw new Error("expected path");
      const raw = JSON.parse(await readFile(written, "utf8")) as {
        servers: Record<string, { type: string; url: string }>;
      };
      expect(raw.servers["corpus-ops"]).toEqual({
        type: "http",
        url: "https://corpus.example/mcp",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
