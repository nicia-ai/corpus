import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import type { ProjectId } from "@/ids";
import { hrefToDocSlug, isExternalHref } from "@/lib/doc-href";

// Follow a rendered markdown link: an external target opens in a new tab; an
// in-project document slug routes within the project. Shared by the editor and
// the read-only history view so a clicked link behaves the same on both.
// Memoized so the callback identity is stable across re-renders — it's passed
// into MarkdownEditor's onFollowLink ref and would otherwise re-seed the ref
// on every parent render.
export function useFollowDocLink(projectId: ProjectId): (href: string) => void {
  const navigate = useNavigate();
  return useCallback(
    (href: string): void => {
      if (isExternalHref(href)) {
        window.open(href, "_blank", "noopener");
        return;
      }
      const slug = hrefToDocSlug(href);
      if (slug !== "") {
        void navigate({
          to: "/p/$projectId/documents/$slug",
          params: { projectId, slug },
        });
      }
    },
    [navigate, projectId],
  );
}
