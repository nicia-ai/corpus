import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";

import { DocHeader } from "@/components/document/DocHeader";
import { DocumentHistory } from "@/components/document-history/DocumentHistory";
import { asProjectId } from "@/ids";
import {
  getDocumentHistoryPage,
  getDocumentHistoryVersion,
} from "@/lib/server/document-review";

const versionSearch = z.object({
  version: z.coerce.number().int().positive().optional(),
});

// The Versions tab. Its own route loader: the version chain is fetched
// only when this route is active (and warmed on hover by the router's
// intent preloading), never on the document page's initial load.
export const Route = createFileRoute("/p/$projectId/documents/$slug/versions")({
  component: VersionsTab,
  validateSearch: versionSearch,
  // Search-only history navigation is handled by the component's event-driven
  // version fetch. Keep the stable document/index loader cached; explicit
  // router invalidation still overrides this after a restore.
  shouldReload: false,
  loader: async ({ params, location }) => {
    const parsed = versionSearch.safeParse(
      Object.fromEntries(new URLSearchParams(location.searchStr)),
    );
    return getDocumentHistoryPage({
      data: {
        projectId: params.projectId,
        slug: params.slug,
        version: parsed.success ? parsed.data.version : undefined,
      },
    });
  },
});

function VersionsTab(): React.ReactElement {
  const { doc, history, active: loadedActive } = Route.useLoaderData();
  const search = Route.useSearch();
  const projectId = asProjectId(Route.useParams().projectId);
  const navigate = useNavigate();
  const [loadedVersions, setLoadedVersions] = useState(
    () =>
      new Map(
        loadedActive === undefined
          ? []
          : [[loadedActive.docVersion, loadedActive] as const],
      ),
  );
  const active =
    (search.version === undefined
      ? loadedActive
      : loadedVersions.get(search.version)) ?? loadedActive;

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
        onSelectVersion={async (version) => {
          if (!loadedVersions.has(version)) {
            const loaded = await getDocumentHistoryVersion({
              data: { projectId, slug: doc.slug, version },
            });
            if (loaded === undefined) {
              throw new Error("That version is no longer available.");
            }
            setLoadedVersions((current) =>
              new Map(current).set(version, loaded),
            );
          }
          await navigate({
            to: "/p/$projectId/documents/$slug/versions",
            params: { projectId, slug: doc.slug },
            search: { version },
            replace: true,
          });
        }}
      />
    </div>
  );
}
