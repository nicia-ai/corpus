import { createFileRoute } from "@tanstack/react-router";

import { DocumentCurrentPage } from "@/features/documents/DocumentCurrentPage";
import { asProjectId } from "@/ids";
import { getDocumentReview } from "@/lib/server/document-review";

export const Route = createFileRoute("/p/$projectId/documents/$slug/")({
  component: CurrentTabRoute,
  // One server-function invocation: document head + review state + the
  // project's doc refs for link resolution. Independent store reads are
  // parallelized inside the server function, so request middleware and the
  // browser/server boundary are crossed once.
  loader: async ({ params }) => {
    return getDocumentReview({
      data: { projectId: params.projectId, slug: params.slug },
    });
  },
});

function CurrentTabRoute(): React.ReactElement {
  const { doc, blocks, comments, suggestions, viewerId, docRefs } =
    Route.useLoaderData();
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
      viewerId={viewerId}
      docRefs={docRefs}
    />
  );
}
