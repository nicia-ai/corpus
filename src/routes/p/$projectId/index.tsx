import {
  createFileRoute,
  getRouteApi,
  Link,
  redirect,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { FilePlus, Plug, Plus, Upload } from "lucide-react";

import { EXAMPLE_GRAPH } from "@/components/project-graph/layout";
import { ProjectGraph } from "@/components/project-graph/ProjectGraph";
import { Button, buttonStyles } from "@/components/ui/Button";
import { RelativeTime } from "@/components/ui/DateTime";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState, listSurface } from "@/components/ui/Surface";
import { showToast } from "@/components/ui/Toast";
import {
  asCorpusSlug,
  asProjectId,
  type CorpusSlug,
  type ProjectId,
} from "@/ids";
import { actor, humanize, subject } from "@/lib/changes-format";
import { TAGLINE, TAGLINE_LONG } from "@/lib/copy";
import { useSubmit } from "@/lib/forms";
import { type Change, getChanges } from "@/lib/server/changes";
import { connectThisCorpus } from "@/lib/server/connections";
import {
  type CorpusMeta,
  type CorpusMember,
  seedExample,
} from "@/lib/server/corpora";
import { loadDashboard } from "@/lib/server/session";

export const Route = createFileRoute("/p/$projectId/")({
  component: Dashboard,
  loader: async ({ params }) => {
    const [data, changes] = await Promise.all([
      loadDashboard({ data: { projectId: params.projectId } }),
      getChanges({ data: { projectId: params.projectId } }),
    ]);
    if (!data.authed || data.firstRun) throw redirect({ to: "/" });
    return { ...data, changes };
  },
});

const layout = getRouteApi("/p/$projectId");

function Dashboard() {
  const projectId = asProjectId(Route.useParams().projectId);
  const data = Route.useLoaderData();
  const router = useRouter();
  const shell = layout.useLoaderData();
  const isOwner = shell.current.role === "owner";

  // Default corpus is always materialized — emptiness is "no documents".
  // A Connection row is not "an agent connected"; do not gate Home on it.
  if (data.documents.length === 0) {
    return (
      <SeedChooser
        projectId={projectId}
        onResult={(didSeed) => {
          if (didSeed) {
            showToast(
              "Example loaded — edit any document to see linked corpora update.",
            );
          }
          void router.invalidate();
        }}
      />
    );
  }

  return (
    <Home
      projectId={projectId}
      corpora={data.corpora}
      docCount={data.documents.length}
      members={data.members}
      connectionsByCorpus={data.connectionsByCorpus}
      changes={data.changes}
      isOwner={isOwner}
    />
  );
}

// Populated project home: the project's pulse. The corpora strip is
// the primary action surface — agents bind per-Corpus (v4), so the
// per-Project MCP URL doesn't belong here. Recent activity sits below
// as the read-only feed.
function Home(
  props: Readonly<{
    projectId: ProjectId;
    corpora: readonly CorpusMeta[];
    docCount: number;
    members: readonly CorpusMember[];
    connectionsByCorpus: Readonly<Record<string, number>>;
    changes: readonly Change[];
    isOwner: boolean;
  }>,
) {
  const { docCount, corpora } = props;
  const colCount = corpora.length;
  const recent = props.changes.slice(0, 12);

  return (
    <div>
      <PageHeader
        title="Home"
        subtitle={`${docCount} document${docCount === 1 ? "" : "s"} · ${colCount} corpus${colCount === 1 ? "" : " corpora"} — no copies, one source of truth.`}
        actions={
          <Link
            to="/p/$projectId/documents/new"
            params={{ projectId: props.projectId }}
            className={buttonStyles("secondary")}
          >
            + New document
          </Link>
        }
      />

      <CorpusStrip
        projectId={props.projectId}
        corpora={corpora}
        members={props.members}
        connectionsByCorpus={props.connectionsByCorpus}
        changes={props.changes}
        isOwner={props.isOwner}
      />

      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-base font-medium text-slate-700">
          Recent activity
        </h2>
        <Link
          to="/p/$projectId/activity"
          params={{ projectId: props.projectId }}
          className="text-sm text-blue-600 hover:text-blue-700"
        >
          View all
        </Link>
      </div>
      {recent.length === 0 ? (
        <EmptyState>
          No changes yet. Edits and attachments show up here.
        </EmptyState>
      ) : (
        <ol className={listSurface("divide-y divide-slate-200")}>
          {recent.map((c) => (
            <li
              key={c.id}
              className="flex items-center gap-3 px-4 py-3 text-base"
            >
              <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-sm font-medium text-slate-600">
                {humanize(c.eventType)}
              </span>
              <span className="min-w-0 flex-1 truncate text-slate-900">
                {subject(c) ?? <span className="text-slate-400">—</span>}
              </span>
              <span className="shrink-0 text-sm text-slate-500">
                {actor(c.changedByName, c.changedBy)}
              </span>
              <RelativeTime
                iso={c.changedAt}
                className="shrink-0 text-sm tabular-nums text-slate-400"
              />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function CorpusStrip(
  props: Readonly<{
    projectId: ProjectId;
    corpora: readonly CorpusMeta[];
    members: readonly CorpusMember[];
    connectionsByCorpus: Readonly<Record<string, number>>;
    changes: readonly Change[];
    isOwner: boolean;
  }>,
) {
  const docCount = new Map<string, number>();
  for (const m of props.members) {
    docCount.set(m.corpusSlug, (docCount.get(m.corpusSlug) ?? 0) + 1);
  }
  const lastActivity = new Map<string, string>();
  for (const c of props.changes) {
    if (c.corpusSlug === null || lastActivity.has(c.corpusSlug)) continue;
    lastActivity.set(c.corpusSlug, c.changedAt);
  }

  return (
    <section className="mb-10">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-base font-medium text-slate-700">Your corpora</h2>
        <Link
          to="/p/$projectId/corpora"
          params={{ projectId: props.projectId }}
          className="text-sm text-blue-600 hover:text-blue-700"
        >
          View all
        </Link>
      </div>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {props.corpora.map((col) => (
          <CorpusCard
            key={col.slug}
            projectId={props.projectId}
            col={col}
            docCount={docCount.get(col.slug) ?? 0}
            agentCount={props.connectionsByCorpus[col.slug] ?? 0}
            lastActivityAt={lastActivity.get(col.slug)}
            isOwner={props.isOwner}
          />
        ))}
        <li>
          <Link
            to="/p/$projectId/corpora"
            params={{ projectId: props.projectId }}
            className="flex h-full min-h-28 items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-500 hover:border-slate-400 hover:text-slate-900"
          >
            <Plus className="size-4" />
            New corpus
          </Link>
        </li>
      </ul>
    </section>
  );
}

function CorpusCard(
  props: Readonly<{
    projectId: ProjectId;
    col: CorpusMeta;
    docCount: number;
    agentCount: number;
    lastActivityAt: string | undefined;
    isOwner: boolean;
  }>,
) {
  const { col, docCount, agentCount, lastActivityAt } = props;
  const docs = `${docCount} doc${docCount === 1 ? "" : "s"}`;
  const agents =
    agentCount === 0
      ? "no agents"
      : `${agentCount} agent${agentCount === 1 ? "" : "s"}`;
  // agentCount is Connection rows for this corpus — a prep signal for
  // owners, not proof an agent completed OAuth.
  const showConnect = props.isOwner && agentCount === 0;

  return (
    <li className="rounded-lg border border-slate-200 bg-white">
      <Link
        to="/p/$projectId/corpora/$slug"
        params={{ projectId: props.projectId, slug: col.slug }}
        className="block h-full px-4 py-3 hover:bg-slate-50"
      >
        <div className="truncate text-base font-semibold text-slate-900">
          {col.name}
        </div>
        <div className="mt-1 text-sm text-slate-500">
          {docs} · {agents}
        </div>
        <div className="mt-2 text-sm text-slate-400">
          {lastActivityAt === undefined ? (
            "no activity yet"
          ) : (
            <>
              last edit <RelativeTime iso={lastActivityAt} />
            </>
          )}
        </div>
      </Link>
      {showConnect && (
        <div className="border-t border-slate-100 px-4 py-2">
          <ConnectCorpusButton
            projectId={props.projectId}
            corpusSlug={asCorpusSlug(col.slug)}
          />
        </div>
      )}
    </li>
  );
}

function ConnectCorpusButton(
  props: Readonly<{ projectId: ProjectId; corpusSlug: CorpusSlug }>,
): React.ReactElement {
  const nav = useNavigate();
  const { pending, run } = useSubmit(async () => {
    await connectThisCorpus({
      data: { projectId: props.projectId, corpusSlug: props.corpusSlug },
    });
    await nav({
      to: "/p/$projectId/connectors/mcp/setup",
      params: { projectId: props.projectId },
      search: { corpus: props.corpusSlug },
    });
  });
  return (
    <Button
      type="button"
      variant="secondary"
      disabled={pending}
      onClick={() => {
        void run();
      }}
      className="inline-flex w-full items-center justify-center gap-1.5!"
    >
      <Plug className="size-4" />
      {pending ? "Connecting…" : "Connect agent"}
    </Button>
  );
}

// Empty project: the ghost fan-out graph IS the empty state — the
// product's one memorable thing (one document → many corpora → many
// agents, no copies) is shown, not described. "Load our example" is the
// satisficing primary; Upload / Create are the other two doors. Seedable
// while the only corpus is the empty default.
function SeedChooser(
  props: Readonly<{
    projectId: ProjectId;
    onResult: (didSeed: boolean) => void;
  }>,
) {
  const { current } = layout.useLoaderData();
  const { pending, error, run } = useSubmit(async () => {
    const r = await seedExample({ data: { projectId: props.projectId } });
    props.onResult(r.seeded);
  });

  return (
    <div>
      <div className="mb-6">
        <p className="text-sm font-medium text-slate-500">
          {current.project.name} is empty
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-900">
          {TAGLINE}
        </h1>
        <p className="mt-1 max-w-2xl text-base text-slate-500">
          {TAGLINE_LONG} Start one of three ways:
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button disabled={pending} onClick={() => void run()}>
            {pending ? "Loading…" : "Load our example"}
          </Button>
          <Link
            to="/p/$projectId/import"
            params={{ projectId: props.projectId }}
            className={buttonStyles(
              "secondary",
              "inline-flex items-center gap-2",
            )}
          >
            <Upload className="size-4" aria-hidden />
            Upload documents
          </Link>
          <Link
            to="/p/$projectId/documents/new"
            params={{ projectId: props.projectId }}
            className={buttonStyles(
              "secondary",
              "inline-flex items-center gap-2",
            )}
          >
            <FilePlus className="size-4" aria-hidden />
            Create a document
          </Link>
        </div>
        {error && <p className="mt-3 text-base text-red-600">{error}</p>}
      </div>
      <ProjectGraph {...EXAMPLE_GRAPH} />
    </div>
  );
}
