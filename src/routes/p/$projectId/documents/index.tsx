import { createFileRoute } from "@tanstack/react-router";

import { DocumentsPage } from "@/features/documents/DocumentsPage";
import { asProjectId } from "@/ids";
import { getCorpusList } from "@/lib/server/corpora";
import {
  type DocListItem,
  getDocumentList,
  getRecentDocuments,
} from "@/lib/server/documents";
import { type FolderRow, getFolderList } from "@/lib/server/folders";
import { listCreateProposals } from "@/lib/server/suggestions";
import { Route as ProjectRoute } from "@/routes/p/$projectId/route";

export const Route = createFileRoute("/p/$projectId/documents/")({
  component: DocumentsRoute,
  // The corpora are the page. The project-wide document and folder lists
  // feed only the first-upload card, so they load only while no page
  // exists. Create-proposals surface here too: an agent-proposed NEW
  // document has no document page of its own to review on, and this is
  // where a curator already scans documents.
  loader: async ({ params }) => {
    const { projectId } = params;
    const [corpora, recentDocuments, proposals] = await Promise.all([
      getCorpusList({ data: { projectId } }),
      getRecentDocuments({ data: { projectId } }),
      listCreateProposals({ data: { projectId } }),
    ]);
    const empty = corpora.every((c) => c.documentCount === 0);
    return {
      corpora,
      recentDocuments,
      proposals,
      uploadContext: empty ? await loadUploadContext(projectId) : undefined,
    };
  },
});

async function loadUploadContext(
  projectId: string,
): Promise<Readonly<{ documents: DocListItem[]; folders: FolderRow[] }>> {
  const [documents, folders] = await Promise.all([
    getDocumentList({ data: { projectId } }),
    getFolderList({ data: { projectId } }),
  ]);
  return { documents, folders };
}

function DocumentsRoute(): React.ReactElement {
  const data = Route.useLoaderData();
  return (
    <DocumentsPage
      projectId={asProjectId(Route.useParams().projectId)}
      corpora={data.corpora}
      recentDocuments={data.recentDocuments}
      proposals={data.proposals}
      uploadContext={data.uploadContext}
      isOwner={ProjectRoute.useLoaderData().current.role === "owner"}
    />
  );
}
