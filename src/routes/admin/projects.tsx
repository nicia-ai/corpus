import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { RelativeTime } from "@/components/ui/DateTime";
import { EmptyState, listSurface } from "@/components/ui/Surface";
import { showToast } from "@/components/ui/Toast";
import {
  adminListProjects,
  adminListProjectStats,
  adminRefreshProjectStats,
  type AdminProjectRow,
  type AdminProjectStatsRow,
} from "@/lib/server/admin";

export const Route = createFileRoute("/admin/projects")({
  component: AdminProjectsPage,
  loader: async () => {
    const [usage, stats] = await Promise.all([
      adminListProjects(),
      adminListProjectStats(),
    ]);
    return { ...usage, stats };
  },
});

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${String(Math.round(n / 1024))} KB`;
  return `${String(n)} B`;
}

const num = "px-4 py-2 text-right tabular-nums text-slate-600";

function AdminProjectsPage(): React.ReactElement {
  const { projects, truncatedAt, stats } = Route.useLoaderData();
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
            <thead className="border-b border-slate-200 bg-slate-50 text-sm text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Project</th>
                <th className="px-4 py-2 font-medium">Organization</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 text-right font-medium">Docs</th>
                <th className="px-4 py-2 text-right font-medium">Corpora</th>
                <th className="px-4 py-2 text-right font-medium">Versions</th>
                <th className="px-4 py-2 text-right font-medium">Storage</th>
                <th className="px-4 py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {projects.map((p: AdminProjectRow) => (
                <tr key={p.id}>
                  <td className="px-4 py-2">
                    <div className="font-medium text-slate-900">{p.name}</div>
                    <div className="text-sm text-slate-500">{p.slug}</div>
                  </td>
                  <td className="px-4 py-2 text-slate-600">
                    {p.organizationName}
                  </td>
                  <td className="px-4 py-2 text-slate-600">{p.status}</td>
                  <td className={num}>{p.documents}</td>
                  <td className={num}>{p.corpora}</td>
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
        <p className="text-sm text-slate-500">
          Showing the {truncatedAt} most recent projects — per-project content
          is read one Durable Object at a time, so the list is capped.
          Pagination is the next step.
        </p>
      )}
      <StructureSection rows={stats} />
    </div>
  );
}

function StructureSection({
  rows,
}: Readonly<{ rows: readonly AdminProjectStatsRow[] }>): React.ReactElement {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function refresh(row: AdminProjectStatsRow): Promise<void> {
    setBusyId(row.projectId);
    try {
      const result = await adminRefreshProjectStats({
        data: { projectId: row.projectId },
      });
      showToast(
        result.ok
          ? `Refreshed ${row.name}.`
          : `Refresh failed (${result.errorKind}).`,
      );
      await router.invalidate();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="space-y-4 pt-4">
      <div>
        <h2 className="text-sm font-semibold text-slate-700">Structure</h2>
        <p className="text-sm text-slate-500">
          Counts only, refreshed daily. Documents are live (non-archived).
          Layout shows how far a project is from one tree per corpus: corpora
          with a root, documents outside any root, and pre-drive links still
          present.
        </p>
      </div>
      <div className={listSurface()}>
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-sm text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">Project</th>
              <th className="px-4 py-2 text-right font-medium">Docs</th>
              <th className="px-4 py-2 text-right font-medium">
                In 0 / 1 / 2+
              </th>
              <th className="px-4 py-2 text-right font-medium">Corpora</th>
              <th className="px-4 py-2 text-right font-medium">Max members</th>
              <th className="px-4 py-2 text-right font-medium">Folders</th>
              <th className="px-4 py-2 text-right font-medium">
                Cross-corpus links
              </th>
              <th className="px-4 py-2 text-right font-medium">Layout</th>
              <th className="px-4 py-2 font-medium">Computed</th>
              <th className="px-4 py-2 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <StructureRow
                key={r.projectId}
                row={r}
                busy={busyId === r.projectId}
                onRefresh={() => void refresh(r)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function StructureRow({
  row,
  busy,
  onRefresh,
}: Readonly<{
  row: AdminProjectStatsRow;
  busy: boolean;
  onRefresh: () => void;
}>): React.ReactElement {
  const s = row.stats;
  return (
    <tr>
      <td className="px-4 py-2">
        <div className="font-medium text-slate-900">{row.name}</div>
        <div className="text-sm text-slate-500">{row.organizationName}</div>
      </td>
      <td className={num}>{s === null ? "—" : s.documents.live}</td>
      <td className={num}>
        {s === null
          ? "—"
          : `${String(s.documents.inNoCorpus)} / ${String(s.documents.inOneCorpus)} / ${String(s.documents.inTwoOrMoreCorpora)}`}
      </td>
      <td className={num}>{s === null ? "—" : s.corpora.total}</td>
      <td className={num}>{s === null ? "—" : s.corpora.maxMembers}</td>
      <td className={num}>{s === null ? "—" : s.folders.total}</td>
      <td className={num}>{s === null ? "—" : s.links.crossCorpus}</td>
      <td className={`${num} whitespace-nowrap`}>
        {s === null ? (
          "—"
        ) : (
          <>
            <div>{`${String(s.layout.corporaWithRoot)} / ${String(s.corpora.total)} rooted`}</div>
            <div>{`${String(s.layout.documentsOutsideRoots)} outside roots`}</div>
            <div>{`legacy ${String(s.layout.legacyDirectLinks)} doc / ${String(s.layout.legacyFolderLinks)} folder`}</div>
          </>
        )}
      </td>
      <td className="px-4 py-2 text-slate-600">
        {row.computedAt === null ? (
          "Never"
        ) : (
          <RelativeTime iso={new Date(row.computedAt).toISOString()} />
        )}
        {row.errorKind !== null && (
          <div className="text-sm text-red-700">
            Last attempt failed: {row.errorKind}
          </div>
        )}
      </td>
      <td className="px-4 py-2 text-right">
        <Button variant="secondary" disabled={busy} onClick={onRefresh}>
          {busy ? "Refreshing…" : "Refresh now"}
        </Button>
      </td>
    </tr>
  );
}
