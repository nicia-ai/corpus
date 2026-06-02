import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { z } from "zod";

import { McpSetupPage } from "@/features/connectors/McpSetupPage";
import { asProjectId } from "@/ids";
import { listConnectionApiKeys } from "@/lib/server/api-keys";
import { getCollectionMeta } from "@/lib/server/collections";
import { getMcpUrl } from "@/lib/server/session";

const layout = getRouteApi("/p/$projectId");

export const Route = createFileRoute("/p/$projectId/connectors/mcp/setup")({
  component: SetupMcpRoute,
  // `?collection=<slug>` lands here from the Collection page's "Connect
  // this collection" action. When present, snippets use a per-Connection
  // `corpus-<slug>` server name so two collections do not overwrite each
  // other in one client config.
  validateSearch: z.object({ collection: z.string().optional() }),
  loaderDeps: ({ search }) => ({ collection: search.collection }),
  loader: async ({ params, deps }) => {
    const [url, connection, col] = await Promise.all([
      getMcpUrl(),
      deps.collection === undefined
        ? Promise.resolve(undefined)
        : listConnectionApiKeys({
            data: {
              projectId: params.projectId,
              collectionSlug: deps.collection,
            },
          }),
      deps.collection === undefined
        ? Promise.resolve(undefined)
        : getCollectionMeta({
            data: { projectId: params.projectId, slug: deps.collection },
          }),
    ]);
    return { url, connection, col };
  },
});

function SetupMcpRoute(): React.ReactElement {
  const data = Route.useLoaderData();
  const { collection } = Route.useSearch();
  const { current } = layout.useLoaderData();
  const projectId = asProjectId(Route.useParams().projectId);
  return (
    <McpSetupPage
      projectId={projectId}
      role={current.role}
      collection={collection}
      url={data.url}
      connection={data.connection}
      col={data.col}
    />
  );
}
