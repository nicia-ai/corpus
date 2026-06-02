import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { DocumentCurrentPage } from "@/features/documents/DocumentCurrentPage";
import { asProjectId } from "@/ids";

const layout = getRouteApi("/p/$projectId/documents/$slug");

export const Route = createFileRoute("/p/$projectId/documents/$slug/")({
  component: CurrentTabRoute,
});

function CurrentTabRoute(): React.ReactElement | null {
  const { doc } = layout.useLoaderData();
  return (
    <DocumentCurrentPage
      doc={doc}
      projectId={asProjectId(Route.useParams().projectId)}
    />
  );
}
