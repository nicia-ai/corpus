import {
  createFileRoute,
  getRouteApi,
  useRouter,
} from "@tanstack/react-router";
import { useState } from "react";

import { Field } from "@/components/Field";
import { Button } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Surface";
import { showToast } from "@/components/ui/Toast";
import { DEFAULT_PROJECT_SLUG } from "@/control/org-lifecycle";
import { asProjectId } from "@/ids";
import { useSubmit } from "@/lib/forms";
import { exportBundle } from "@/lib/server/bundle";
import { archiveProject, renameProject } from "@/lib/server/projects";

// Project management. No own loader — it reads the parent `/p/$projectId`
// shell (already loaded for the sidebar switcher), so rename/archive and
// the switcher can't show a stale name. Owner-gated UI; the server fns
// re-check ownership regardless.
export const Route = createFileRoute("/p/$projectId/settings")({
  component: ProjectSettings,
});

const layout = getRouteApi("/p/$projectId");

function ProjectSettings() {
  const projectId = asProjectId(Route.useParams().projectId);
  const router = useRouter();
  const { current } = layout.useLoaderData();
  const isOwner = current.role === "owner";
  // The org's `default` project is the resolver's landing fallback;
  // archiving it would strand the org (the server refuses it too).
  const isDefault = current.project.slug === DEFAULT_PROJECT_SLUG;
  const [name, setName] = useState(current.project.name);

  const rename = useSubmit(async () => {
    await renameProject({ data: { projectId, name } });
    showToast("Project renamed");
    await router.invalidate();
  });

  // Owner-only download. The bundle is a plain JSON object — stringify
  // it client-side and trigger a download via an object URL so the user
  // sees a single click → file landing in Downloads, no extra route.
  const exportProject = useSubmit(async () => {
    const bundle = await exportBundle({ data: { projectId } });
    const json = JSON.stringify(bundle, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const a = document.createElement("a");
    a.href = url;
    a.download = `corpus-bundle-${current.project.slug}-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Defer the revoke: Safari/Firefox start reading the blob on a
    // later tick after a.click(), so a synchronous revoke can race
    // with download initiation and produce a zero-byte file.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  });

  const archive = useSubmit(async () => {
    const ok = await confirmDialog({
      title: `Archive “${current.project.name}”?`,
      body: "Members lose access immediately. This cannot be undone from the UI.",
      confirmLabel: "Archive",
      tone: "danger",
    });
    if (!ok) return;
    const r = await archiveProject({ data: { projectId } });
    if (!r.ok) throw new Error("The default project cannot be archived.");
    // Full-page nav (not the SPA router): drops every cached loader
    // result so no archived-project data survives. The `/` resolver
    // re-lands on the org's default project.
    window.location.href = "/";
  });

  if (!isOwner) {
    return (
      <>
        <PageHeader
          title="Project settings"
          subtitle="Only an organization owner can manage this project."
        />
        <Card className="max-w-xl">
          <dl className="space-y-3 text-base">
            <div>
              <dt className="text-sm font-medium text-slate-500">Name</dt>
              <dd className="text-slate-900">{current.project.name}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-slate-500">
                Organization
              </dt>
              <dd className="text-slate-900">{current.orgName}</dd>
            </div>
          </dl>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Project settings" subtitle={`In ${current.orgName}`} />
      <div className="max-w-xl space-y-6">
        <Card>
          <h2 className="mb-1 text-xl font-semibold">Rename project</h2>
          <p className="mb-4 text-base text-slate-500">
            The display name only. The project URL never changes.
          </p>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void rename.run();
            }}
          >
            <Field label="Project name" value={name} onChange={setName} />
            {rename.error && (
              <p className="text-base text-red-600">{rename.error}</p>
            )}
            <Button
              type="submit"
              disabled={
                rename.pending ||
                name.trim() === "" ||
                name === current.project.name
              }
            >
              Save
            </Button>
          </form>
        </Card>

        <Card>
          <h2 className="mb-1 text-xl font-semibold">Export project</h2>
          <p className="mb-4 text-base text-slate-500">
            Download a deterministic, content-addressed bundle of every
            document, collection, folder, and the full version history.
            Re-importable into any Corpus instance.
          </p>
          {exportProject.error && (
            <p className="mb-3 text-base text-red-600">{exportProject.error}</p>
          )}
          <Button
            disabled={exportProject.pending}
            onClick={() => void exportProject.run()}
          >
            {exportProject.pending ? "Exporting…" : "Export bundle"}
          </Button>
        </Card>

        <Card>
          <h2 className="mb-1 text-xl font-semibold">Archive project</h2>
          <p className="mb-4 text-base text-slate-500">
            {isDefault
              ? "This is the organization’s default project and cannot be archived."
              : "Members lose access immediately. This cannot be undone from the UI."}
          </p>
          {archive.error && (
            <p className="mb-3 text-base text-red-600">{archive.error}</p>
          )}
          <Button
            variant="danger"
            disabled={isDefault || archive.pending}
            onClick={() => void archive.run()}
          >
            Archive project
          </Button>
        </Card>
      </div>
    </>
  );
}
