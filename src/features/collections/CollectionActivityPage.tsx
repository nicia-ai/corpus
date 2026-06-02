import { useRouter } from "@tanstack/react-router";
import { X as XIcon } from "lucide-react";
import { useState } from "react";

import { BackLink } from "@/components/ui/BackLink";
import { Button } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { RelativeTime } from "@/components/ui/DateTime";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { cardClass, EmptyState, listSurface } from "@/components/ui/Surface";
import { textLinkClass } from "@/components/ui/text-link";
import type { CollectionSlug, ProjectId } from "@/ids";
import { cn } from "@/lib/cn";
import type {
  ActivityAgentRow,
  ActivityDTO,
  ActivityStatus,
  RecentEventRow,
} from "@/lib/server/activity";
import { recordPromptAnswer } from "@/lib/server/activity-prompt";

export function CollectionActivityPage({
  data,
  projectId,
  slug,
}: Readonly<{
  data: ActivityDTO;
  projectId: ProjectId;
  slug: CollectionSlug;
}>): React.JSX.Element {
  const router = useRouter();
  const subtitle =
    data.lastEditAt === undefined ? (
      "No edits yet."
    ) : (
      <>
        Last edit · <RelativeTime iso={data.lastEditAt} />
        {data.lastEditBy !== undefined ? ` by ${data.lastEditBy}` : ""}
      </>
    );

  return (
    <div className="pb-12">
      <BackLink
        to="/p/$projectId/collections/$slug"
        projectId={projectId}
        slug={slug}
        label={data.contextName}
      />
      <PageHeader
        title={`${data.contextName} · Activity`}
        subtitle={subtitle}
      />

      {data.promptVisible && (
        <PostActivationPromptCard
          collectionSlug={slug}
          projectId={projectId}
          onAnswered={() => router.invalidate()}
        />
      )}

      <ConnectedAgentsSection
        agents={data.agents}
        hasAnyAgents={data.hasAnyAgents}
        mcpUrl={data.mcpUrl}
      />

      <RecentActivitySection rows={data.recentActivity} />
    </div>
  );
}

const PROMPT_BETS: readonly Readonly<{
  value:
    | "shared-prompts-skills"
    | "version-quality-measurement"
    | "off-laptop-reactivity"
    | "policy-change-approval"
    | "none";
  label: string;
}>[] = [
  {
    value: "shared-prompts-skills",
    label: "Share my agent prompts/skills with the team",
  },
  {
    value: "version-quality-measurement",
    label: "Know which version each agent used / measure quality",
  },
  {
    value: "off-laptop-reactivity",
    label: "Run agents on a schedule or events, not just my laptop",
  },
  {
    value: "policy-change-approval",
    label: "Control who can change or approve what",
  },
  { value: "none", label: "None — this already works" },
];

function PostActivationPromptCard({
  collectionSlug,
  projectId,
  onAnswered,
}: Readonly<{
  collectionSlug: CollectionSlug;
  projectId: ProjectId;
  onAnswered: () => void;
}>): React.JSX.Element | null {
  const [dismissed, setDismissed] = useState(false);
  const [selected, setSelected] = useState<
    (typeof PROMPT_BETS)[number]["value"] | undefined
  >(undefined);
  const [submitting, setSubmitting] = useState(false);
  if (dismissed) return null;

  const submit = async (): Promise<void> => {
    if (selected === undefined) return;
    setSubmitting(true);
    try {
      await recordPromptAnswer({
        data: { bet: selected, collectionSlug, projectId },
      });
      onAnswered();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={cardClass("mb-6 p-5")}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            What would most help your whole team use this?
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            One answer per team. Shapes what we build next.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="rounded-md p-1 text-slate-400 hover:bg-slate-50 hover:text-slate-900"
          aria-label="Dismiss"
        >
          <XIcon className="size-4" />
        </button>
      </div>
      <fieldset className="mt-4 space-y-2">
        {PROMPT_BETS.map((b) => (
          <label
            key={b.value}
            className="flex cursor-pointer items-center gap-3 text-base text-slate-900"
          >
            <input
              type="radio"
              name="bet"
              value={b.value}
              checked={selected === b.value}
              onChange={() => setSelected(b.value)}
              className="size-4 accent-blue-600"
            />
            {b.label}
          </label>
        ))}
      </fieldset>
      <div className="mt-5 flex items-center gap-3">
        <Button
          variant="primary"
          onClick={() => void submit()}
          disabled={selected === undefined || submitting}
        >
          {submitting ? "Submitting…" : "Submit"}
        </Button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className={textLinkClass("text-sm")}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

function ConnectedAgentsSection({
  agents,
  hasAnyAgents,
  mcpUrl,
}: Readonly<{
  agents: readonly ActivityAgentRow[];
  hasAnyAgents: boolean;
  mcpUrl: string;
}>): React.JSX.Element {
  return (
    <Section label="Connected agents" className="mb-8">
      {!hasAnyAgents ? (
        <EmptyAgentsState mcpUrl={mcpUrl} />
      ) : (
        <AgentsTable agents={agents} />
      )}
    </Section>
  );
}

// The MCP URL is the primary action — copying it is the first concrete
// step toward connecting an agent, so this view never feels like a dead
// screen.
function EmptyAgentsState({
  mcpUrl,
}: Readonly<{ mcpUrl: string }>): React.JSX.Element {
  return (
    <div className={cardClass()}>
      <h3 className="text-lg font-semibold text-slate-900">
        No agents connected yet
      </h3>
      <p className="mt-1 max-w-prose text-base text-slate-500">
        Point Claude Code or Codex at this URL with a scoped API key, and
        you&rsquo;ll see what each agent reads here.
      </p>
      <div className="mt-4 flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-sm text-slate-900">
          {mcpUrl}
        </code>
        <CopyButton value={mcpUrl} label="Copy MCP URL" />
      </div>
    </div>
  );
}

function StatusChip({
  status,
  staleVersionMap,
}: Readonly<{
  status: ActivityStatus;
  staleVersionMap?: ActivityAgentRow["staleVersionMap"];
}>): React.JSX.Element {
  if (status === "fresh") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-2 py-0.5 text-sm font-medium text-blue-600">
        <span
          className="size-1.5 rounded-full bg-blue-600"
          aria-hidden="true"
        />
        Fresh
      </span>
    );
  }
  if (status === "stale" && staleVersionMap !== undefined) {
    const first = Object.entries(staleVersionMap)[0];
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2 py-0.5 text-sm font-medium text-amber-700">
        <span
          className="size-1.5 rounded-full bg-amber-500"
          aria-hidden="true"
        />
        Stale
        {first !== undefined && (
          <span className="ml-1 font-normal tabular-nums text-amber-700/80">
            v{String(first[1].captured)} → v{String(first[1].current)}
          </span>
        )}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-sm font-medium text-slate-600">
      Awaiting first read
    </span>
  );
}

function AgentsTable({
  agents,
}: Readonly<{ agents: readonly ActivityAgentRow[] }>): React.JSX.Element {
  return (
    <>
      {/* ≥720px: dense column table. The freshness chip stays in the
          rightmost column where the eye lands. */}
      <div className={listSurface("hidden md:block")}>
        <table className="w-full text-base">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-sm text-slate-500">
              <th className="px-4 py-3 font-medium">Agent</th>
              <th className="px-4 py-3 font-medium">Caller</th>
              <th className="px-4 py-3 font-medium">Last read</th>
              <th className="px-4 py-3 text-right font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {agents.map((a) => (
              <tr key={a.callerRef} className="hover:bg-slate-50">
                <td className="px-4 py-3 font-medium text-slate-900">
                  {a.callerLabel}
                </td>
                <td className="px-4 py-3 font-mono text-sm text-slate-500">
                  {a.callerRef}
                </td>
                <td className="px-4 py-3 text-sm tabular-nums text-slate-500">
                  <RelativeTime iso={a.lastReadAt} />
                </td>
                <td className="px-4 py-3 text-right">
                  <StatusChip
                    status={a.status}
                    staleVersionMap={a.staleVersionMap}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* <720px: card-stack. Status chip stays top-right at every width. */}
      <ul className="space-y-2 md:hidden">
        {agents.map((a) => (
          <li
            key={a.callerRef}
            className="rounded-md border border-slate-200 bg-white p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <h4 className="text-base font-medium text-slate-900">
                {a.callerLabel}
              </h4>
              <StatusChip
                status={a.status}
                staleVersionMap={a.staleVersionMap}
              />
            </div>
            <p className="mt-1 font-mono text-sm text-slate-500">
              {a.callerRef}
            </p>
            <p className="mt-2 text-sm tabular-nums text-slate-500">
              Last read · <RelativeTime iso={a.lastReadAt} />
            </p>
          </li>
        ))}
      </ul>
    </>
  );
}

function RecentActivitySection({
  rows,
}: Readonly<{ rows: readonly RecentEventRow[] }>): React.JSX.Element {
  return (
    <Section label="Recent activity">
      {rows.length === 0 ? (
        <EmptyState>No activity yet.</EmptyState>
      ) : (
        <ul className={listSurface("divide-y divide-slate-200")}>
          {rows.map((r) => (
            <li
              key={r.monotonicId}
              className="flex items-center justify-between gap-3 px-4 py-3 text-base"
            >
              <div className="flex min-w-0 items-center gap-3">
                <EventTypeBadge type={r.eventType} />
                <span
                  className={cn(
                    "min-w-0 truncate",
                    r.eventType.startsWith("read.")
                      ? "text-slate-500"
                      : "text-slate-900",
                  )}
                >
                  {r.description}
                </span>
              </div>
              <RelativeTime
                iso={r.timestamp}
                className="shrink-0 text-sm tabular-nums text-slate-400"
              />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function EventTypeBadge({
  type,
}: Readonly<{ type: string }>): React.JSX.Element {
  const isRead = type.startsWith("read.");
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-sm font-medium tabular-nums",
        isRead ? "bg-blue-50 text-blue-600" : "bg-slate-100 text-slate-600",
      )}
    >
      {type}
    </span>
  );
}
