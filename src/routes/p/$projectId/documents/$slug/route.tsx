import { createFileRoute, Outlet } from "@tanstack/react-router";

import { BackLink } from "@/components/ui/BackLink";
import { asProjectId } from "@/ids";

// Layout for a single document. Child routes own their complete data payloads
// so TanStack's parallel parent/child loaders cannot render mixed snapshots.
export const Route = createFileRoute("/p/$projectId/documents/$slug")({
  component: DocumentLayout,
});

function DocumentLayout(): React.ReactElement {
  const projectId = asProjectId(Route.useParams().projectId);

  return (
    <>
      <BackLink
        to="/p/$projectId/documents"
        projectId={projectId}
        label="Documents"
        className="mb-2 inline-block"
      />
      <Outlet />
    </>
  );
}
