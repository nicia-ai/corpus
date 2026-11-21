import { createFileRoute, Outlet } from "@tanstack/react-router";

import { BackLink } from "@/components/ui/BackLink";
import { asProjectId } from "@/ids";
import { getDocumentLocation } from "@/lib/server/documents";

// Layout for a single document. Child routes own their complete data payloads
// so TanStack's parallel parent/child loaders cannot render mixed snapshots;
// this loader carries only where the document lives (its back link).
export const Route = createFileRoute("/p/$projectId/documents/$slug")({
  loader: ({ params }) =>
    getDocumentLocation({
      data: { projectId: params.projectId, slug: params.slug },
    }),
  component: DocumentLayout,
});

function DocumentLayout(): React.ReactElement {
  const projectId = asProjectId(Route.useParams().projectId);
  const location = Route.useLoaderData();

  return (
    <>
      {location === undefined ? (
        <BackLink
          to="/p/$projectId/documents"
          projectId={projectId}
          label="Corpora"
          className="mb-2 inline-block"
        />
      ) : (
        <div className="mb-2 flex flex-wrap items-baseline gap-x-3">
          <BackLink
            to="/p/$projectId/corpora/$slug"
            projectId={projectId}
            slug={location.corpusSlug}
            label={location.corpusName}
          />
          <span className="text-sm text-slate-500">
            {location.served ? "Shared with agents" : "Draft — not shared"}
          </span>
        </div>
      )}
      <Outlet />
    </>
  );
}
