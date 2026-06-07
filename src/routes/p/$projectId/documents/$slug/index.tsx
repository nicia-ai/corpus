import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { DocumentCurrentPage } from "@/features/documents/DocumentCurrentPage";
import { asProjectId } from "@/ids";
import { getDocumentBlocks, listComments } from "@/lib/server/comments";

const layout = getRouteApi("/p/$projectId/documents/$slug");

export const Route = createFileRoute("/p/$projectId/documents/$slug/")({
  component: CurrentTabRoute,
  // Comments + the head block list load with the Current tab so the rendered
  // document is commentable immediately (select text → comment), and
  // `router.invalidate()` (after a mutation or a live nudge) refreshes them.
  // The Versions tab has its own loader and pays none of this.
  loader: async ({ params }) => {
    const [blocks, comments] = await Promise.all([
      getDocumentBlocks({
        data: { projectId: params.projectId, slug: params.slug },
      }),
      listComments({
        data: { projectId: params.projectId, slug: params.slug },
      }),
    ]);
    return { blocks, comments };
  },
});

function CurrentTabRoute(): React.ReactElement | null {
  const { doc } = layout.useLoaderData();
  const { blocks, comments } = Route.useLoaderData();
  return (
    <DocumentCurrentPage
      doc={doc}
      projectId={asProjectId(Route.useParams().projectId)}
      blocks={blocks}
      comments={comments}
    />
  );
}
