import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { z } from "zod";

import { McpSetupPage } from "@/features/connectors/McpSetupPage";
import { asProjectId } from "@/ids";
import { listConnectionApiKeys } from "@/lib/server/api-keys";
import { getCorpusMeta } from "@/lib/server/corpora";
import { getMcpUrl } from "@/lib/server/session";

const layout = getRouteApi("/p/$projectId");

export const Route = createFileRoute("/p/$projectId/connectors/mcp/setup")({
  component: SetupMcpRoute,
  // `?corpus=<slug>` lands here from the Corpus page's "Connect
  // this corpus" action. When present, snippets use a per-Connection
  // `corpus-<slug>` server name so two corpora do not overwrite each
  // other in one client config.
  validateSearch: z.object({ corpus: z.string().optional() }),
  loaderDeps: ({ search }) => ({ corpus: search.corpus }),
  loader: async ({ params, deps }) => {
    const [url, connection, col] = await Promise.all([
      getMcpUrl(),
      deps.corpus === undefined
        ? Promise.resolve(undefined)
        : listConnectionApiKeys({
            data: {
              projectId: params.projectId,
              corpusSlug: deps.corpus,
            },
          }),
      deps.corpus === undefined
        ? Promise.resolve(undefined)
        : getCorpusMeta({
            data: { projectId: params.projectId, slug: deps.corpus },
          }),
    ]);
    return { url, connection, col };
  },
});

function SetupMcpRoute(): React.ReactElement {
  const data = Route.useLoaderData();
  const { corpus } = Route.useSearch();
  const { current } = layout.useLoaderData();
  const projectId = asProjectId(Route.useParams().projectId);
  return (
    <McpSetupPage
      projectId={projectId}
      role={current.role}
      corpus={corpus}
      url={data.url}
      connection={data.connection}
      col={data.col}
    />
  );
}
