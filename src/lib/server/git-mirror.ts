import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { asCorpusSlug } from "@/ids";
import { projectMiddleware } from "@/lib/middleware";
import { changedBy, requireProjectOwner, storeOf } from "@/lib/server/shared";
import { assertServerContext as srv } from "@/lib/server-context";
import type { GitMirrorStatus } from "@/store/domain/git-mirror";

export type { GitMirrorStatus } from "@/store/domain/git-mirror";

export type RebuildGitMirrorOutcome = Readonly<
  { ok: true } | { ok: false; reason: "not-enabled" | "not-found" }
>;

const REBUILD_FORBIDDEN_MSG =
  "Only a project owner can rebuild a corpus's Git mirror";

// What the Connect page shows under "Clone with Git": whether the mirror is
// on, and how current it is. Reading it is what starts the mirror for a
// corpus that has none yet.
export const getGitMirrorStatus = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .validator(z.object({ corpusSlug: z.string().min(1) }))
  .handler(async ({ data, context }): Promise<GitMirrorStatus> => {
    return storeOf(srv(context)).gitMirrorStatus(asCorpusSlug(data.corpusSlug));
  });

// Throw the repository away and rebuild it from the corpus as it is now.
// This is the only thing that purges history, so it is owner-only.
export const rebuildGitMirror = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(z.object({ corpusSlug: z.string().min(1) }))
  .handler(async ({ data, context }): Promise<RebuildGitMirrorOutcome> => {
    const c = srv(context);
    requireProjectOwner(c.project, REBUILD_FORBIDDEN_MSG);
    return storeOf(c).rebuildGitMirror(
      asCorpusSlug(data.corpusSlug),
      changedBy(c),
    );
  });
