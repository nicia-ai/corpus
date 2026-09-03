import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";

import { Field } from "@/components/Field";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { cardClass, EmptyState, listSurface } from "@/components/ui/Surface";
import { asProjectId, type ProjectId } from "@/ids";
import { track } from "@/lib/analytics";
import { WHAT_IS_A_CORPUS } from "@/lib/copy";
import { useSubmit } from "@/lib/forms";
import {
  createCorpus,
  getCorpusList,
  type CorpusListItem,
} from "@/lib/server/corpora";

export const Route = createFileRoute("/p/$projectId/corpora/")({
  component: Corpora,
  loader: async ({ params }) => ({
    corpora: await getCorpusList({
      data: { projectId: params.projectId },
    }),
  }),
});

function Corpora() {
  const { corpora } = Route.useLoaderData();
  const projectId = asProjectId(Route.useParams().projectId);
  const [creating, setCreating] = useState(false);

  return (
    <div className="pb-12">
      <PageHeader
        title="Corpora"
        subtitle={<span className="block max-w-prose">{WHAT_IS_A_CORPUS}</span>}
        actions={
          !creating && (
            <Button
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1.5!"
            >
              <Plus className="size-4" />
              Corpus
            </Button>
          )
        }
      />

      {creating && (
        <CreateForm projectId={projectId} onCancel={() => setCreating(false)} />
      )}

      {corpora.length === 0 && !creating ? (
        <EmptyState>
          <span className="mb-1 block font-medium text-slate-900">
            No corpora yet
          </span>
          Create one, then attach the documents an agent should read.
        </EmptyState>
      ) : (
        corpora.length > 0 && (
          // The house list surface (same as Changes and the dashboard):
          // one bordered panel, divided rows — reads as a real list, not
          // a stretched empty slab.
          <ul className={listSurface("divide-y divide-slate-200")}>
            {corpora.map((c: CorpusListItem) => (
              <li key={c.slug}>
                <Link
                  to="/p/$projectId/corpora/$slug"
                  params={{ projectId, slug: c.slug }}
                  className="flex items-center gap-4 px-4 py-3 hover:bg-slate-50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-base font-medium text-slate-900">
                      {c.name}
                    </div>
                    {c.description !== undefined && (
                      <div className="mt-0.5 truncate text-sm text-slate-500">
                        {c.description}
                      </div>
                    )}
                  </div>
                  <span className="shrink-0 text-sm text-slate-500 tabular-nums">
                    {c.documentCount} document
                    {c.documentCount === 1 ? "" : "s"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}

function CreateForm({
  projectId,
  onCancel,
}: Readonly<{ projectId: ProjectId; onCancel: () => void }>) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const {
    pending,
    error,
    run: submit,
  } = useSubmit(async () => {
    const desc = description.trim();
    const r = await createCorpus({
      data:
        desc === ""
          ? { projectId, name: name.trim() }
          : { projectId, name: name.trim(), description: desc },
    });
    track("corpus_created", { projectId, slug: r.slug });
    // Land in the builder so the next step — attaching documents — is
    // immediate, not a second navigation the user has to discover.
    await navigate({
      to: "/p/$projectId/corpora/$slug",
      params: { projectId, slug: r.slug },
    });
  });

  return (
    <form
      className={cardClass("mb-6 max-w-xl space-y-4")}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field label="Name" value={name} onChange={setName} />
      <Field
        label="Description"
        required={false}
        value={description}
        onChange={setDescription}
      />
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending || name.trim() === ""}>
          {pending ? "Creating…" : "Create corpus"}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </form>
  );
}
