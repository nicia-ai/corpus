import { createFileRoute } from "@tanstack/react-router";

import { DocumentCurrentPage } from "@/features/documents/DocumentCurrentPage";
import { asProjectId } from "@/ids";
import { getDocumentReview } from "@/lib/server/document-review";

export const Route = createFileRoute("/p/$projectId/documents/$slug/")({
  component: CurrentTabRoute,
  // One review payload: document head + anchor blocks + comments + suggestions.
  // Mutations and live nudges refresh this same loader via router.invalidate().
  loader: async ({ params }) => {
    return getDocumentReview({
      data: { projectId: params.projectId, slug: params.slug },
    });
  },
});

function CurrentTabRoute(): React.ReactElement {
  const { doc, blocks, comments, suggestions } = Route.useLoaderData();
  const projectId = asProjectId(Route.useParams().projectId);
  if (doc === undefined) {
    return <p className="mt-4 text-slate-500">Document not found.</p>;
  }
  return (
    <DocumentCurrentPage
      doc={doc}
      projectId={projectId}
      blocks={blocks}
      comments={comments}
      suggestions={suggestions}
    />
  );
}
