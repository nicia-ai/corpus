import {
  createFileRoute,
  getRouteApi,
  Link,
  redirect,
  useRouter,
} from "@tanstack/react-router";
import { FilePlus, Plus, Upload } from "lucide-react";

import { EXAMPLE_GRAPH } from "@/components/project-graph/layout";
import { ProjectGraph } from "@/components/project-graph/ProjectGraph";
import { Button, buttonStyles } from "@/components/ui/Button";
import { RelativeTime } from "@/components/ui/DateTime";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState, listSurface } from "@/components/ui/Surface";
import { showToast } from "@/components/ui/Toast";
import { asProjectId, type ProjectId } from "@/ids";
import { actor, humanize, subject } from "@/lib/changes-format";
import { TAGLINE, TAGLINE_LONG } from "@/lib/copy";
import { useSubmit } from "@/lib/forms";
import { type Change, getChanges } from "@/lib/server/changes";
import {
  type ColMeta,
  type CollectionMember,
  seedExample,
} from "@/lib/server/collections";
import { loadDashboard } from "@/lib/server/session";

export const Route = createFileRoute("/p/$projectId/")({
  component: Dashboard,
  loader: async ({ params }) => {
    // Membership was already gated by the `p.$projectId` layout; an
    // unauthed / project-less answer here means a stale tab — re-resolve
    // from the top rather than render an empty shell. Fetched in
    // parallel because `getChanges` does not depend on the dashboard
    // payload; a redirect still wins via `throw`.
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

  const empty = data.collections.length === 0 && data.documents.length === 0;
  if (empty) {
    return (
      <SeedChooser
        projectId={projectId}
        onResult={(didSeed) => {
          if (didSeed) {
            showToast(
              "Example loaded — edit any document to see linked collections update.",
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
      collections={data.collections}
      docCount={data.documents.length}
      members={data.members}
      connectionsByCollection={data.connectionsByCollection}
      changes={data.changes}
    />
  );
}

// Populated project home: the project's pulse. The collections strip is
// the primary action surface — agents bind per-Collection (v4), so the
// per-Project MCP URL doesn't belong here. Recent activity sits below
// as the read-only feed.
function Home(
  props: Readonly<{
    projectId: ProjectId;
    collections: readonly ColMeta[];
    docCount: number;
    members: readonly CollectionMember[];
    connectionsByCollection: Readonly<Record<string, number>>;
    changes: readonly Change[];
  }>,
) {
  const { docCount, collections } = props;
  const colCount = collections.length;
  const recent = props.changes.slice(0, 12);

  return (
    <div>
      <PageHeader
        title="Home"
        subtitle={`${docCount} document${docCount === 1 ? "" : "s"} · ${colCount} collection${colCount === 1 ? "" : "s"} — no copies, one source of truth.`}
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

      {/* members feed the per-collection document counts */}
      <CollectionStrip
        projectId={props.projectId}
        collections={collections}
        members={props.members}
        connectionsByCollection={props.connectionsByCollection}
        changes={props.changes}
      />

      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-base font-medium text-slate-700">
          Recent activity
        </h2>
        <Link
          to="/p/$projectId/changes"
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

// One row per Collection; click a card to land on its detail page
// (where the per-Collection "Connect" action lives). The "+ New
// collection" tile is always present so creating one is a single click
// from Home — it lands on the Collections list, where the inline create
// form opens.
//
// "Last activity" is derived from the project's change log (already in
// the dashboard payload) rather than the per-Collection event-log fold —
// the event log would be a 1000-event read per Collection per Home
// render. The change log misses MCP-call events but catches every
// edit/attach, which is what "active" means for the contributors
// looking at Home.
function CollectionStrip(
  props: Readonly<{
    projectId: ProjectId;
    collections: readonly ColMeta[];
    members: readonly CollectionMember[];
    connectionsByCollection: Readonly<Record<string, number>>;
    changes: readonly Change[];
  }>,
) {
  const docCount = new Map<string, number>();
  for (const m of props.members) {
    docCount.set(m.collectionSlug, (docCount.get(m.collectionSlug) ?? 0) + 1);
  }
  const lastActivity = new Map<string, string>();
  for (const c of props.changes) {
    if (c.collectionSlug === null || lastActivity.has(c.collectionSlug))
      continue;
    lastActivity.set(c.collectionSlug, c.changedAt);
  }

  return (
    <section className="mb-10">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-base font-medium text-slate-700">
          Your collections
        </h2>
        <Link
          to="/p/$projectId/collections"
          params={{ projectId: props.projectId }}
          className="text-sm text-blue-600 hover:text-blue-700"
        >
          View all
        </Link>
      </div>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {props.collections.map((col) => (
          <CollectionCard
            key={col.slug}
            projectId={props.projectId}
            col={col}
            docCount={docCount.get(col.slug) ?? 0}
            agentCount={props.connectionsByCollection[col.slug] ?? 0}
            lastActivityAt={lastActivity.get(col.slug)}
          />
        ))}
        <li>
          <Link
            to="/p/$projectId/collections"
            params={{ projectId: props.projectId }}
            className="flex h-full min-h-28 items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-500 hover:border-slate-400 hover:text-slate-900"
          >
            <Plus className="size-4" />
            New collection
          </Link>
        </li>
      </ul>
    </section>
  );
}

function CollectionCard(
  props: Readonly<{
    projectId: ProjectId;
    col: ColMeta;
    docCount: number;
    agentCount: number;
    lastActivityAt: string | undefined;
  }>,
) {
  const { col, docCount, agentCount, lastActivityAt } = props;
  const docs = `${docCount} doc${docCount === 1 ? "" : "s"}`;
  const agents =
    agentCount === 0
      ? "no agents"
      : `${agentCount} agent${agentCount === 1 ? "" : "s"}`;
  return (
    <li>
      <Link
        to="/p/$projectId/collections/$slug"
        params={{ projectId: props.projectId, slug: col.slug }}
        className="block h-full rounded-lg border border-slate-200 bg-white px-4 py-3 hover:border-slate-300"
      >
        <div className="truncate text-base font-semibold text-slate-900">
          {col.name}
        </div>
        <div className="mt-1 text-sm text-slate-500">
          {docs} · {agents}
        </div>
        <div className="mt-2 text-xs text-slate-400">
          {lastActivityAt === undefined ? (
            "no activity yet"
          ) : (
            <>
              last edit <RelativeTime iso={lastActivityAt} />
            </>
          )}
        </div>
      </Link>
    </li>
  );
}

// Empty project: the ghost fan-out graph IS the empty state — the
// product's one memorable thing (one document → many collections → many
// agents, no copies) is shown, not described. The header states the
// payoff and the three distinct ways to fill the project: "Load the
// example" is the satisficing primary (a first-timer lands in a
// populated project with no decision); "Upload documents" imports
// existing markdown; "Create a document" writes one from scratch.
function SeedChooser(
  props: Readonly<{
    projectId: ProjectId;
    onResult: (didSeed: boolean) => void;
  }>,
) {
  const { current } = layout.useLoaderData();
  const { pending, error, run } = useSubmit(async () => {
    // The guard makes a double-click / already-populated project a no-op;
    // only a real seed should flash the "loaded" confirmation.
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
