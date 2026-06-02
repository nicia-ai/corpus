import { createFileRoute } from "@tanstack/react-router";

import { RelativeTime } from "@/components/ui/DateTime";
import { EmptyState, listSurface } from "@/components/ui/Surface";
import { adminListProjects } from "@/lib/server/admin";

export const Route = createFileRoute("/admin/projects")({
  component: AdminProjectsPage,
  loader: () => adminListProjects(),
});

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${String(Math.round(n / 1024))} KB`;
  return `${String(n)} B`;
}

const num = "px-4 py-2 text-right tabular-nums text-slate-600";

function AdminProjectsPage(): React.ReactElement {
  const { projects, truncatedAt } = Route.useLoaderData();
  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-slate-700">
        Projects ({projects.length})
      </h2>
      {projects.length === 0 ? (
        <EmptyState>No projects yet.</EmptyState>
      ) : (
        <div className={listSurface()}>
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs tracking-wide text-slate-500 uppercase">
              <tr>
                <th className="px-4 py-2 font-medium">Project</th>
                <th className="px-4 py-2 font-medium">Organization</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 text-right font-medium">Docs</th>
                <th className="px-4 py-2 text-right font-medium">
                  Collections
                </th>
                <th className="px-4 py-2 text-right font-medium">Versions</th>
                <th className="px-4 py-2 text-right font-medium">Storage</th>
                <th className="px-4 py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {projects.map((p) => (
                <tr key={p.id}>
                  <td className="px-4 py-2">
                    <div className="font-medium text-slate-900">{p.name}</div>
                    <div className="text-xs text-slate-500">{p.slug}</div>
                  </td>
                  <td className="px-4 py-2 text-slate-600">
                    {p.organizationName}
                  </td>
                  <td className="px-4 py-2 text-slate-600">{p.status}</td>
                  <td className={num}>{p.documents}</td>
                  <td className={num}>{p.collections}</td>
                  <td className={num}>{p.versions}</td>
                  <td className={num}>{fmtBytes(p.markdownBytes)}</td>
                  <td className="px-4 py-2 text-slate-600">
                    <RelativeTime iso={new Date(p.createdAt).toISOString()} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {truncatedAt !== null && (
        <p className="text-xs text-slate-500">
          Showing the {truncatedAt} most recent projects — per-project content
          is read one Durable Object at a time, so the list is capped.
          Pagination is the next step.
        </p>
      )}
    </div>
  );
}
