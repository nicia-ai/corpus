import { createFileRoute } from "@tanstack/react-router";

import { CorpusActivityPage } from "@/features/corpora/CorpusActivityPage";
import { asCorpusSlug, asProjectId } from "@/ids";
import { getCorpusActivity, type ActivityDTO } from "@/lib/server/activity";

export const Route = createFileRoute("/p/$projectId/corpora/$slug_/activity")({
  component: ActivityRoute,
  loader: async ({ params }): Promise<ActivityDTO> => {
    return await getCorpusActivity({
      data: { slug: params.slug, projectId: params.projectId },
    });
  },
});

function ActivityRoute(): React.JSX.Element {
  return (
    <CorpusActivityPage
      data={Route.useLoaderData()}
      projectId={asProjectId(Route.useParams().projectId)}
      slug={asCorpusSlug(Route.useParams().slug)}
    />
  );
}
