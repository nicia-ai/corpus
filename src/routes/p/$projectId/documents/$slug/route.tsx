import { createFileRoute, Outlet } from "@tanstack/react-router";

import { BackLink } from "@/components/ui/BackLink";
import { asProjectId } from "@/ids";
import { getDocument } from "@/lib/server/documents";

// Layout for a single document. It owns the one document fetch; the two
// tabs are child routes (`index` = Current, `versions` = Versions) so each
// tab's data is its own loader — opening Versions is what triggers the
// history fetch, not page load.
export const Route = createFileRoute("/p/$projectId/documents/$slug")({
  component: DocumentLayout,
  loader: async ({ params }) => ({
    doc: await getDocument({
      data: { projectId: params.projectId, slug: params.slug },
    }),
  }),
});

function DocumentLayout(): React.ReactElement {
  const { doc } = Route.useLoaderData();
  const projectId = asProjectId(Route.useParams().projectId);

  if (doc === undefined) {
    return (
      <div className="mx-auto max-w-3xl">
        <BackLink
          to="/p/$projectId/documents"
          projectId={projectId}
          label="Documents"
        />
        <p className="mt-4 text-slate-500">Document not found.</p>
      </div>
    );
  }

  return (
    <>
      <BackLink
        to="/p/$projectId/documents"
        projectId={projectId}
        label="Documents"
      />
      <Outlet />
    </>
  );
}
