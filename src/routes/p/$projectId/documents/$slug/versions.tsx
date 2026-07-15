import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { DocHeader } from "@/components/document/DocHeader";
import { DocumentHistory } from "@/components/document-history/DocumentHistory";
import { asProjectId } from "@/ids";
import { getDocumentHistoryPage } from "@/lib/server/document-review";

// The Versions tab. Its own route loader: the version chain is fetched
// only when this route is active (and warmed on hover by the router's
// intent preloading), never on the document page's initial load.
export const Route = createFileRoute("/p/$projectId/documents/$slug/versions")({
  component: VersionsTab,
  validateSearch: z.object({
    version: z.coerce.number().int().positive().optional(),
  }),
  loaderDeps: ({ search }) => ({ version: search.version }),
  loader: async ({ params, deps }) => {
    return getDocumentHistoryPage({
      data: {
        projectId: params.projectId,
        slug: params.slug,
        version: deps.version,
      },
    });
  },
});

function VersionsTab(): React.ReactElement {
  const { doc, history, active } = Route.useLoaderData();
  const projectId = asProjectId(Route.useParams().projectId);

  if (doc === undefined) {
    return <p className="mt-4 text-slate-500">Document not found.</p>;
  }

  return (
    <div className="max-w-5xl">
      <DocHeader
        slug={doc.slug}
        projectId={projectId}
        title={doc.title}
        version={doc.docVersion}
        active="versions"
      />
      <DocumentHistory
        current={doc}
        entries={history}
        active={active}
        projectId={projectId}
      />
    </div>
  );
}
