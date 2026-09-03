import { createFileRoute } from "@tanstack/react-router";

import { DocumentsPage } from "@/features/documents/DocumentsPage";
import { asProjectId } from "@/ids";
import { getCorpusList, type CorpusListItem } from "@/lib/server/corpora";
import { getDocumentList } from "@/lib/server/documents";
import { getFolderList } from "@/lib/server/folders";
import { listCreateProposals } from "@/lib/server/suggestions";

export const Route = createFileRoute("/p/$projectId/documents/")({
  component: DocumentsRoute,
  // Corpora feed the empty-state uploader's "link to a corpus"
  // picker and nothing else on this page — fetch them only when we're
  // actually going to render that picker. Create-proposals surface here
  // too: an agent-proposed NEW document has no document page of its own
  // to review on, and this is where a curator already scans documents.
  loader: async ({ params }) => {
    const { projectId } = params;
    const [documents, folders, proposals] = await Promise.all([
      getDocumentList({ data: { projectId } }),
      getFolderList({ data: { projectId } }),
      listCreateProposals({ data: { projectId } }),
    ]);
    const corpora: readonly CorpusListItem[] =
      documents.length === 0 && folders.length === 0
        ? await getCorpusList({ data: { projectId } })
        : [];
    return { documents, folders, corpora, proposals };
  },
});

function DocumentsRoute(): React.ReactElement {
  const data = Route.useLoaderData();
  return (
    <DocumentsPage
      projectId={asProjectId(Route.useParams().projectId)}
      documents={data.documents}
      folders={data.folders}
      corpora={data.corpora}
      proposals={data.proposals}
    />
  );
}
