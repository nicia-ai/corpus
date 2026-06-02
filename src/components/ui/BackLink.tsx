import { Link } from "@tanstack/react-router";

import { textLinkClass } from "@/components/ui/text-link";
import type { CollectionSlug, ProjectId } from "@/ids";

// `to` covers the list routes AND the collection-detail route so a
// sub-page (activity, MCP setup launched from a Collection) points
// back to its parent, not all the way to the list — which would lose
// the user's place.
export function BackLink(
  props: Readonly<
    | {
        to: "/p/$projectId/collections" | "/p/$projectId/documents";
        projectId: ProjectId;
        label: string;
      }
    | {
        to: "/p/$projectId/collections/$slug";
        projectId: ProjectId;
        slug: CollectionSlug;
        label: string;
      }
  >,
): React.ReactElement {
  if (props.to === "/p/$projectId/collections/$slug") {
    return (
      <Link
        to={props.to}
        params={{ projectId: props.projectId, slug: props.slug }}
        className={textLinkClass("text-sm")}
      >
        ← {props.label}
      </Link>
    );
  }
  return (
    <Link
      to={props.to}
      params={{ projectId: props.projectId }}
      className={textLinkClass("text-sm")}
    >
      ← {props.label}
    </Link>
  );
}
