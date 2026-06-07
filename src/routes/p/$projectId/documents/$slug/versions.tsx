import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { DocHeader } from "@/components/document/DocHeader";
import { DocumentHistory } from "@/components/document-history/DocumentHistory";
import { asProjectId } from "@/ids";
import { getDocumentHistory } from "@/lib/server/documents";

// The Versions tab. Its own route loader: the version chain is fetched
// only when this route is active (and warmed on hover by the router's
// intent preloading), never on the document page's initial load.
const layout = getRouteApi("/p/$projectId/documents/$slug");

export const Route = createFileRoute("/p/$projectId/documents/$slug/versions")({
  component: VersionsTab,
  loader: async ({ params }) => ({
    history: await getDocumentHistory({
      data: { projectId: params.projectId, slug: params.slug },
    }),
  }),
});

function VersionsTab(): React.ReactElement | null {
  const { doc } = layout.useLoaderData();
  const { history } = Route.useLoaderData();
  const projectId = asProjectId(Route.useParams().projectId);

  if (doc === undefined) return null;

  return (
    <div className="max-w-5xl">
      <DocHeader
        slug={doc.slug}
        projectId={projectId}
        title={doc.title}
        version={doc.docVersion}
        active="versions"
      />
      <DocumentHistory current={doc} entries={history} projectId={projectId} />
    </div>
  );
}
