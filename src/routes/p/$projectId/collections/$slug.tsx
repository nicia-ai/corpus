import {
  createFileRoute,
  getRouteApi,
  Link,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { Plug } from "lucide-react";
import { useState } from "react";

import { BudgetMeter, sizeStateFor } from "@/components/collection/BudgetMeter";
import { CorpusBrowser } from "@/components/collection/CorpusBrowser";
import { BackLink } from "@/components/ui/BackLink";
import { Button, buttonStyles } from "@/components/ui/Button";
import { Section } from "@/components/ui/Section";
import { CollectionMembers } from "@/features/collections/CollectionMembers";
import { EditCollectionForm } from "@/features/collections/EditCollectionForm";
import { asCollectionSlug, asProjectId } from "@/ids";
import { useSubmit } from "@/lib/forms";
import { attachDocument, getCollectionDetail } from "@/lib/server/collections";
import { connectThisCollection } from "@/lib/server/connections";
import { getDocumentList } from "@/lib/server/documents";
import { attachFolderToCollection, getFolderList } from "@/lib/server/folders";
import { manifestTokens } from "@/util";

export const Route = createFileRoute("/p/$projectId/collections/$slug")({
  component: CollectionView,
  loader: async ({ params }) => {
    const { projectId } = params;
    const [col, docs, folders] = await Promise.all([
      getCollectionDetail({ data: { projectId, slug: params.slug } }),
      getDocumentList({ data: { projectId } }),
      getFolderList({ data: { projectId } }),
    ]);
    return { slug: params.slug, col, docs, folders };
  },
});

const layout = getRouteApi("/p/$projectId");

function CollectionView() {
  const { col, docs, folders } = Route.useLoaderData();
  const params = Route.useParams();
  const projectId = asProjectId(params.projectId);
  const slug = asCollectionSlug(params.slug);
  const router = useRouter();
  const nav = useNavigate();
  const [editing, setEditing] = useState(false);
  // "Connect this collection" is owner-only (the server fn calls
  // requireProjectOwner). Read the role from the parent shell so the
  // button is hidden for members instead of letting them click and get
  // a raw 'Only an organization owner can manage Connections' error.
  const isOwner = layout.useLoaderData().current.role === "owner";

  // "Connect this collection" — the primary path per the v4 design.
  // Reuse-or-create the canonical Connection for this Collection, write
  // the userId-keyed pending-connect intent (so /connect/select can
  // pre-select on an OAuth handshake), then take the owner to the
  // setup page with `?collection=<slug>` so its snippets use the per-
  // Connection `corpus-<slug>` server name.
  const {
    pending: connecting,
    error: connectError,
    run: connect,
  } = useSubmit(async () => {
    await connectThisCollection({ data: { projectId, collectionSlug: slug } });
    await nav({
      to: "/p/$projectId/connectors/mcp/setup",
      params: { projectId },
      search: { collection: slug },
    });
  });

  if (!col.found) {
    return (
      <div className="mx-auto max-w-3xl">
        <BackLink
          to="/p/$projectId/collections"
          projectId={projectId}
          label="Collections"
        />
        <p className="mt-4 text-slate-500">Collection not found.</p>
      </div>
    );
  }

  if (editing) {
    return (
      <div className="mx-auto max-w-2xl">
        <BackLink
          to="/p/$projectId/collections"
          projectId={projectId}
          label="Collections"
        />
        <EditCollectionForm
          slug={slug}
          projectId={projectId}
          initialName={col.name}
          initialDescription={col.description ?? ""}
          initialAlwaysIncludeBudgetTokens={col.alwaysIncludeBudgetTokens}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void router.invalidate();
          }}
        />
      </div>
    );
  }

  const direct = col.members.filter((m) => m.direct);
  const viaFolder = col.members.filter((m) => !m.direct);
  const memberSlugs = new Set(col.members.map((m) => m.slug));
  const linkedSlugs = new Set(col.folders.map((f) => f.slug));
  const position = col.members.length + 1;
  const budget = col.alwaysIncludeBudgetTokens;
  const coreMembers = col.members.filter((m) => m.delivery === "core");
  const total = manifestTokens(coreMembers);
  const sizeState = sizeStateFor(total, budget);
  // Server truth is the seed; any membership/order change flips this key
  // so the members pane remounts with server order (no useEffect re-seed).
  const orderKey = col.members
    .map((m) => `${m.slug}:${m.delivery}:${String(m.position)}`)
    .join("|");

  return (
    <div className="pb-12">
      <BackLink
        to="/p/$projectId/collections"
        projectId={projectId}
        label="Collections"
      />
      <header className="mt-2 flex items-start justify-between gap-4 border-b border-slate-200 pb-3">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold">{col.name}</h1>
          {col.description !== undefined && col.description.trim() !== "" && (
            <p className="mt-0.5 max-w-prose text-base text-slate-600">
              {col.description}
            </p>
          )}
          {coreMembers.length > 0 && (
            <BudgetMeter total={total} budget={budget} sizeState={sizeState} />
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <div className="flex items-center gap-2">
            {isOwner && (
              <Button
                onClick={() => void connect()}
                disabled={connecting}
                className="inline-flex items-center gap-1.5"
              >
                <Plug className="size-4" />
                {connecting ? "Connecting…" : "Connect this collection"}
              </Button>
            )}
            <Link
              to="/p/$projectId/collections/$slug/activity"
              params={{ projectId, slug }}
              className={buttonStyles("secondary")}
            >
              Activity
            </Link>
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Edit
            </Button>
          </div>
          {isOwner && connectError !== undefined && (
            <p className="text-sm text-red-600">{connectError}</p>
          )}
        </div>
      </header>

      <div className="mt-6 grid items-start gap-8 lg:grid-cols-2 lg:gap-10">
        <CollectionMembers
          key={orderKey}
          slug={slug}
          projectId={projectId}
          budget={budget}
          direct={direct}
          viaFolder={viaFolder}
          linkedFolders={col.folders}
        />

        <Section
          label="Add to this collection"
          hint="Added documents are pulled on demand by the agent. Toggle “Always include” on a row to pre-load it into every read_collection call."
        >
          <CorpusBrowser
            documents={docs}
            folders={folders}
            memberSlugs={memberSlugs}
            linkedSlugs={linkedSlugs}
            onDone={() => void router.invalidate()}
            addDocument={(documentSlug) =>
              attachDocument({
                data: {
                  projectId,
                  collectionSlug: slug,
                  documentSlug,
                  position,
                  delivery: "reference",
                },
              })
            }
            addFolder={(folderSlug) =>
              attachFolderToCollection({
                data: {
                  projectId,
                  collectionSlug: slug,
                  folderSlug,
                  position,
                  delivery: "reference",
                },
              })
            }
          />
        </Section>
      </div>
    </div>
  );
}
