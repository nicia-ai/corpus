import { createFileRoute } from "@tanstack/react-router";

import { DocumentCurrentPage } from "@/features/documents/DocumentCurrentPage";
import { asProjectId } from "@/ids";
import { getDocumentReview } from "@/lib/server/document-review";
import { getDocuments } from "@/lib/server/documents";

export const Route = createFileRoute("/p/$projectId/documents/$slug/")({
  component: CurrentTabRoute,
  // One review payload: document head + anchor blocks + comments + suggestions,
  // plus the project's doc slugs for the editor's broken-link linter (the
  // editor is the always-on surface now, so slugs load with the page). The slug
  // fetch is non-fatal — it only feeds a cosmetic linter. Mutations and live
  // nudges refresh this loader via router.invalidate().
  loader: async ({ params }) => {
    const [review, slugs] = await Promise.all([
      getDocumentReview({
        data: { projectId: params.projectId, slug: params.slug },
      }),
      getDocuments({ data: { projectId: params.projectId } })
        .then((docs) => docs.map((d) => d.slug))
        .catch((): string[] => []),
    ]);
    return { ...review, slugs };
  },
});

function CurrentTabRoute(): React.ReactElement {
  const { doc, blocks, comments, suggestions, viewerId, slugs } =
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
      slugs={slugs}
    />
  );
}
