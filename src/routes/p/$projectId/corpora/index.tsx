import { createFileRoute, redirect } from "@tanstack/react-router";

// The corpora ARE the Documents surface; this path survives only so old
// links keep working.
export const Route = createFileRoute("/p/$projectId/corpora/")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/p/$projectId/documents",
      params: { projectId: params.projectId },
    });
  },
});
