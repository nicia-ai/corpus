import { Link } from "@tanstack/react-router";
import { Bot, Plug, Upload } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Surface";
import { showToast } from "@/components/ui/Toast";
import { DocumentUploader } from "@/features/documents/DocumentUploader";
import {
  buildAgentWritePrompt,
  claudeCodeMcpCommand,
  corpusCliMcpAddCommand,
  corpusServerName,
  cursorMcpSnippet,
} from "@/features/onboarding/agent-write-prompt";
import type { CorpusSlug, ProjectId } from "@/ids";
import { TAGLINE, TAGLINE_LONG } from "@/lib/copy";
import { useSubmit } from "@/lib/forms";
import { connectThisCorpus } from "@/lib/server/connections";
import type { CorpusListItem } from "@/lib/server/corpora";
import type { FolderRow } from "@/lib/server/folders";

export function GetStarted(
  props: Readonly<{
    projectId: ProjectId;
    defaultCorpusSlug: CorpusSlug;
    mcpUrl: string;
    isOwner: boolean;
    corpora: readonly CorpusListItem[];
    folders: readonly FolderRow[];
    documents: readonly Readonly<{ path: string }>[];
    /** True when a Connection already exists for the default corpus. */
    alreadyPrepared: boolean;
    onUploadComplete?: () => void;
  }>,
): React.ReactElement {
  const corpusSlug = props.defaultCorpusSlug;
  const serverName = corpusServerName(corpusSlug);
  const [prepared, setPrepared] = useState(props.alreadyPrepared);

  const {
    pending: connecting,
    error: connectError,
    run: connect,
  } = useSubmit(async () => {
    await connectThisCorpus({
      data: { projectId: props.projectId, corpusSlug },
    });
    setPrepared(true);
    showToast(
      "Ready — copy a snippet below, then finish sign-in in your agent.",
    );
  });

  const agentWritePrompt = buildAgentWritePrompt(serverName);
  const cursorSnippet = cursorMcpSnippet(props.mcpUrl, serverName);
  const claudeCommand = claudeCodeMcpCommand(props.mcpUrl, serverName);
  const cliCommand = corpusCliMcpAddCommand(props.mcpUrl, serverName, "cursor");

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={TAGLINE} subtitle={TAGLINE_LONG} />

      <ol className="space-y-4">
        <GetStartedStep
          step={1}
          title="Upload a document"
          icon={Upload}
          subtitle="Markdown or text — it joins your corpus automatically."
        >
          <DocumentUploader
            projectId={props.projectId}
            corpora={props.corpora}
            folders={props.folders}
            documents={props.documents}
            defaultCorpusSlug={corpusSlug}
            autoLinkCorpus
            onComplete={() => {
              showToast(
                "Uploaded — your agents can read it after you connect.",
              );
              props.onUploadComplete?.();
            }}
          />
        </GetStartedStep>

        <GetStartedStep
          step={2}
          title="Connect an agent"
          icon={Plug}
          subtitle="OAuth in Cursor or Claude — the agent reads your corpus over MCP."
        >
          {props.isOwner ? (
            <div className="space-y-3">
              {!prepared && (
                <Button disabled={connecting} onClick={() => void connect()}>
                  {connecting ? "Preparing…" : "Prepare connection"}
                </Button>
              )}
              {connectError && (
                <p className="text-base text-red-600">{connectError}</p>
              )}
              {prepared && (
                <div className="space-y-4">
                  <p className="text-sm text-slate-600">
                    Paste one of these into your agent, then complete the
                    browser sign-in it opens. You already chose this corpus — no
                    second picker.
                  </p>
                  <SnippetBlock
                    label="Fastest — Corpus CLI"
                    value={cliCommand}
                  />
                  <SnippetBlock label="Cursor" value={cursorSnippet} />
                  <SnippetBlock label="Claude Code" value={claudeCommand} />
                  <p className="text-sm text-slate-500">
                    Need API keys or another client?{" "}
                    <Link
                      to="/p/$projectId/connectors/mcp/setup"
                      params={{ projectId: props.projectId }}
                      search={{ corpus: corpusSlug }}
                      className="text-blue-600 hover:text-blue-700"
                    >
                      Full MCP setup
                    </Link>
                  </p>
                </div>
              )}
            </div>
          ) : (
            <p className="text-base text-slate-500">
              Ask your organization owner to connect an agent to this project.
            </p>
          )}
        </GetStartedStep>

        <GetStartedStep
          step={3}
          title="Have your agent write a document"
          icon={Bot}
          subtitle="Connect first, then paste this prompt. The doc appears in your corpus after you approve it."
        >
          <div className="relative">
            <CopyButton
              value={agentWritePrompt}
              label="Copy prompt"
              className="absolute top-2 right-2"
            />
            <pre className="overflow-x-auto rounded-md border border-slate-200 bg-slate-50 p-4 pr-24 font-mono text-sm whitespace-pre-wrap text-slate-900">
              {agentWritePrompt}
            </pre>
          </div>
        </GetStartedStep>
      </ol>

      <p className="mt-8 text-center text-sm text-slate-500">
        Or{" "}
        <Link
          to="/p/$projectId/documents/new"
          params={{ projectId: props.projectId }}
          className="text-blue-600 hover:text-blue-700"
        >
          write a document yourself
        </Link>
        {" · "}
        <Link
          to="/p/$projectId/documents"
          params={{ projectId: props.projectId }}
          className="text-blue-600 hover:text-blue-700"
        >
          browse documents
        </Link>
      </p>
    </div>
  );
}

function GetStartedStep(
  props: Readonly<{
    step: number;
    title: string;
    subtitle: string;
    icon: React.ComponentType<Readonly<{ className?: string }>>;
    children: React.ReactNode;
  }>,
): React.ReactElement {
  const Icon = props.icon;
  return (
    <li>
      <Card className="p-5!">
        <div className="mb-4 flex items-start gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-slate-100 text-sm font-semibold tabular-nums text-slate-600">
            {props.step}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Icon className="size-4 shrink-0 text-slate-500" aria-hidden />
              <h2 className="text-base font-semibold text-slate-900">
                {props.title}
              </h2>
            </div>
            <p className="mt-0.5 text-sm text-slate-500">{props.subtitle}</p>
          </div>
        </div>
        {props.children}
      </Card>
    </li>
  );
}

function SnippetBlock(
  props: Readonly<{ label: string; value: string }>,
): React.ReactElement {
  return (
    <div className="relative">
      <p className="mb-1 font-medium text-slate-700">{props.label}</p>
      <CopyButton
        value={props.value}
        label="Copy"
        className="absolute top-7 right-2"
      />
      <pre className="overflow-x-auto rounded-md border border-slate-200 bg-slate-50 p-3 pr-16 font-mono text-xs whitespace-pre-wrap text-slate-900">
        {props.value}
      </pre>
    </div>
  );
}
