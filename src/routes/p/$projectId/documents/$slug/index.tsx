import { createFileRoute } from "@tanstack/react-router";

import { DocumentCurrentPage } from "@/features/documents/DocumentCurrentPage";
import { asProjectId } from "@/ids";
import { getDocumentReview } from "@/lib/server/document-review";
import { getDocumentRefs } from "@/lib/server/documents";

export const Route = createFileRoute("/p/$projectId/documents/$slug/")({
  component: CurrentTabRoute,
  // One review payload: document head + anchor blocks + comments + suggestions,
  // plus the project's doc refs (slug + path) for the editor's broken-link
  // linter and wikilink resolution (the editor is the always-on surface now,
  // so they load with the page). The doc-list
  // fetch is non-fatal — it only feeds a cosmetic linter. Mutations and live
  // nudges refresh this loader via router.invalidate().
  loader: async ({ params }) => {
    const [review, docRefs] = await Promise.all([
      getDocumentReview({
        data: { projectId: params.projectId, slug: params.slug },
      }),
      getDocumentRefs({ data: { projectId: params.projectId } }).catch(
        (): { slug: string; path: string }[] => [],
      ),
    ]);
    return { ...review, docRefs };
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
