import {
  createFileRoute,
  getRouteApi,
  Link,
  redirect,
  useRouter,
} from "@tanstack/react-router";
import { FilePlus, Upload } from "lucide-react";

import { EXAMPLE_GRAPH } from "@/components/project-graph/layout";
import { ProjectGraph } from "@/components/project-graph/ProjectGraph";
import { Button, buttonStyles } from "@/components/ui/Button";
import { showToast } from "@/components/ui/Toast";
import { asProjectId, type ProjectId } from "@/ids";
import { TAGLINE, TAGLINE_LONG } from "@/lib/copy";
import { useSubmit } from "@/lib/forms";
import { seedExample } from "@/lib/server/corpora";
import { loadProjectLanding } from "@/lib/server/session";

export const Route = createFileRoute("/p/$projectId/")({
  component: EmptyProject,
  loader: async ({ params }) => {
    const data = await loadProjectLanding({
      data: { projectId: params.projectId },
    });
    if (!data.authed || data.firstRun) throw redirect({ to: "/" });
    if (data.hasDocuments) {
      throw redirect({
        to: "/p/$projectId/documents",
        params: { projectId: params.projectId },
      });
    }
    return null;
  },
});

const layout = getRouteApi("/p/$projectId");

function EmptyProject(): React.ReactElement {
  const projectId = asProjectId(Route.useParams().projectId);
  const router = useRouter();
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
