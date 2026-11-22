import {
  createFileRoute,
  getRouteApi,
  useNavigate,
} from "@tanstack/react-router";

import { BackLink } from "@/components/ui/BackLink";
import { CorpusPage } from "@/features/corpora/CorpusPage";
import { asCorpusSlug, asProjectId } from "@/ids";
import { getCorpusList } from "@/lib/server/corpora";
import { getDocumentList } from "@/lib/server/documents";
import { getFolderList } from "@/lib/server/folders";

export const Route = createFileRoute("/p/$projectId/corpora/$slug")({
  component: CorpusRoute,
  loader: async ({ params }) => {
    const { projectId } = params;
    const [corpora, documents, folders] = await Promise.all([
      getCorpusList({ data: { projectId } }),
      getDocumentList({ data: { projectId } }),
      getFolderList({ data: { projectId } }),
    ]);
    return { corpora, documents, folders };
  },
});

const layout = getRouteApi("/p/$projectId");

function CorpusRoute(): React.ReactElement {
  const { corpora, documents, folders } = Route.useLoaderData();
  const params = Route.useParams();
  const projectId = asProjectId(params.projectId);
  const slug = asCorpusSlug(params.slug);
  const navigate = useNavigate();
  const corpus = corpora.find((c) => c.slug === slug);
  const isOwner = layout.useLoaderData().current.role === "owner";

  if (corpus === undefined) {
    return (
      <div className="mx-auto max-w-3xl">
        <BackLink
          to="/p/$projectId/documents"
          projectId={projectId}
          label="Corpora"
        />
        <p className="mt-4 text-slate-500">Corpus not found.</p>
      </div>
    );
  }

  return (
    <CorpusPage
      projectId={projectId}
      corpus={corpus}
      corpora={corpora}
      documents={documents.filter((d) => d.corpusSlug === slug)}
      folders={folders.filter((f) => f.corpusSlug === slug)}
      allFolders={folders}
      isOwner={isOwner}
      onDeleted={() =>
        void navigate({ to: "/p/$projectId/documents", params: { projectId } })
      }
    />
  );
}
