import { createFileRoute } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";

import { RelativeTime } from "@/components/ui/DateTime";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState, listSurface } from "@/components/ui/Surface";
import { actor, humanize, subject } from "@/lib/changes-format";
import { getChanges } from "@/lib/server/changes";

export const Route = createFileRoute("/p/$projectId/changes")({
  component: Changes,
  loader: async ({ params }) => ({
    changes: await getChanges({ data: { projectId: params.projectId } }),
  }),
});

function Changes() {
  const { changes } = Route.useLoaderData();
  return (
    <div>
      <PageHeader
        title="Changes"
        subtitle="Every edit and attachment across this project — click any row for the full recorded event."
      />
      {changes.length === 0 ? (
        <EmptyState>
          No changes yet. Edits and attachments show up here.
        </EmptyState>
      ) : (
        <ol className={listSurface("divide-y divide-slate-200")}>
          {changes.map((c) => {
            const subj = subject(c);
            return (
              <li key={c.id}>
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-center gap-4 px-4 py-3 text-base hover:bg-slate-50">
                    <span className="w-40 shrink-0">
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-sm font-medium text-slate-600">
                        {humanize(c.eventType)}
                      </span>
                    </span>
                    <span className="min-w-0 flex-1 truncate text-slate-900">
                      {subj ?? <span className="text-slate-400">—</span>}
                    </span>
                    <span className="w-32 shrink-0 truncate text-sm text-slate-500">
                      {actor(c.changedByName, c.changedBy)}
                    </span>
                    <RelativeTime
                      iso={c.changedAt}
                      className="w-28 shrink-0 text-right text-sm tabular-nums text-slate-400"
                    />
                    <ChevronRight
                      aria-hidden
                      className="size-4 shrink-0 text-slate-400 transition-transform group-open:rotate-90"
                    />
                  </summary>
                  <pre className="overflow-x-auto border-t border-slate-200 bg-slate-50 px-4 py-3 font-mono text-sm text-slate-700">
                    {c.detail}
                  </pre>
                </details>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
