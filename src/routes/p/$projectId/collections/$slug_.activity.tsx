import { createFileRoute } from "@tanstack/react-router";

import { CollectionActivityPage } from "@/features/collections/CollectionActivityPage";
import { asCollectionSlug, asProjectId } from "@/ids";
import { getCollectionActivity, type ActivityDTO } from "@/lib/server/activity";

export const Route = createFileRoute(
  "/p/$projectId/collections/$slug_/activity",
)({
  component: ActivityRoute,
  loader: async ({ params }): Promise<ActivityDTO> => {
    return await getCollectionActivity({
      data: { slug: params.slug, projectId: params.projectId },
    });
  },
});

function ActivityRoute(): React.JSX.Element {
  return (
    <CollectionActivityPage
      data={Route.useLoaderData()}
      projectId={asProjectId(Route.useParams().projectId)}
      slug={asCollectionSlug(Route.useParams().slug)}
    />
  );
}
