import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { PageHeader } from "@/components/ui/PageHeader";
import { showToast } from "@/components/ui/Toast";
import { DocumentUploader } from "@/features/documents/DocumentUploader";
import { asProjectId } from "@/ids";
import { getCollectionList } from "@/lib/server/collections";
import type { ImportSummary } from "@/project-store";

export const Route = createFileRoute("/p/$projectId/import")({
  component: Import,
  loader: async ({ params }) => ({
    collections: await getCollectionList({
      data: { projectId: params.projectId },
    }),
  }),
});

// Compact summary for the post-import toast, omitting zero parts:
// "12 added · 3 updated · 1 failed".
function importSummary(s: ImportSummary): string {
  const parts: string[] = [];
  if (s.created > 0) parts.push(`${String(s.created)} added`);
  if (s.updated > 0) parts.push(`${String(s.updated)} updated`);
  if (s.failed.length > 0) parts.push(`${String(s.failed.length)} failed`);
  return parts.length === 0 ? "nothing to import" : parts.join(" · ");
}

function Import() {
  const { collections } = Route.useLoaderData();
  const projectId = asProjectId(Route.useParams().projectId);
  const navigate = useNavigate();

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Upload documents"
        subtitle="Pick files, a folder, or a .zip. Folder structure is kept; only Markdown/text files are imported."
      />
      <DocumentUploader
        projectId={projectId}
        collections={collections}
        onComplete={(r) => {
          // Land on Documents so the freshly-imported folder is visible,
          // with the outcome flashed — no bespoke "upload complete" screen.
          showToast(`Import complete — ${importSummary(r.summary)}`);
          void navigate({
            to: "/p/$projectId/documents",
            params: { projectId },
          });
        }}
      />
    </div>
  );
}
