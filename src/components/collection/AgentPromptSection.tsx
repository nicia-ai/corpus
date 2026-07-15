import { CopyButton } from "@/components/ui/CopyButton";
import { Card } from "@/components/ui/Surface";

// The setup snippet wires MCP up; this section wires the *agent* up — the
// nudge it needs to actually reach for the collection. The prompt is
// templated against the bound Connection's server name (`corpus-<slug>`)
// + the collection's name/description, so paste-and-go is honest: the
// agent gets a real trigger and a real description of what's in scope.
export function buildAgentPrompt({
  serverName,
  name,
  description,
}: Readonly<{
  serverName: string;
  name: string;
  description: string | undefined;
}>): string {
  const desc = description?.trim();
  const subject =
    desc !== undefined && desc !== "" ? `${name} — ${desc}` : name;
  return `## Project context — Corpus

\`${serverName}\` is the team's canonical context for ${subject}. Treat what it returns as authoritative; it may supersede your training.

Before working on anything in this area, call \`read_collection\` on \`${serverName}\` for the always-included guidance. Use \`list_documents\` and \`read_document\` to pull specific reference files (by slug or Corpus path like \`docs/brand-voice.md\`).

The team edits these docs in real time. Re-read between major tasks or on long sessions so you don't act on stale context.`;
}

export function AgentPromptSection({
  serverName,
  name,
  description,
}: Readonly<{
  serverName: string;
  name: string;
  description: string | undefined;
}>): React.ReactElement {
  const prompt = buildAgentPrompt({
    serverName,
    name,
    description,
  });
  return (
    <Card className="mt-4 space-y-5 p-4!">
      <div className="relative">
        <CopyButton
          value={prompt}
          label="Copy prompt"
          className="absolute top-2 right-2"
        />
        <pre className="overflow-x-auto rounded-md border border-slate-200 bg-slate-50 p-4 pr-12 font-mono text-sm whitespace-pre-wrap text-slate-900">
          {prompt}
        </pre>
      </div>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="font-medium text-slate-700">Any agent</dt>
        <dd className="text-slate-500">
          Paste into the agent's system prompt or project instructions.
        </dd>
        <dt className="font-medium text-slate-700">Claude Code</dt>
        <dd className="text-slate-500">
          Append to <code className="font-mono">AGENTS.md</code> or{" "}
          <code className="font-mono">CLAUDE.md</code> at the repo root.
        </dd>
        <dt className="font-medium text-slate-700">Codex CLI</dt>
        <dd className="text-slate-500">
          Append to <code className="font-mono">AGENTS.md</code> at the repo
          root.
        </dd>
        <dt className="font-medium text-slate-700">Cursor</dt>
        <dd className="text-slate-500">
          Add as a project rule:{" "}
          <code className="font-mono">.cursor/rules/corpus.mdc</code>.
        </dd>
      </dl>
    </Card>
  );
}
