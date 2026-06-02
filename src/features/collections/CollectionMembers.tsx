import { useRouter } from "@tanstack/react-router";
import { GripVertical } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import {
  type Delivery,
  DeliveryToggle,
  RemoveAction,
} from "@/components/collection/DeliveryControls";
import { DocLine, docMeta, FolderLine } from "@/components/collection/DocLine";
import { Section } from "@/components/ui/Section";
import { EmptyState, listSurface } from "@/components/ui/Surface";
import type { CollectionSlug, FolderSlug, ProjectId } from "@/ids";
import { useSubmit } from "@/lib/forms";
import {
  type ColFolderLink,
  type ColMemberRow,
  detachDocument,
  reorderCollectionDocuments,
  setMemberDelivery,
} from "@/lib/server/collections";
import {
  detachFolderFromCollection,
  setFolderLinkDelivery,
} from "@/lib/server/folders";
import { formatNumber, manifestTokens, pluralize } from "@/util";

// Footer copy is mode-specific so the budget clause never appears when
// nothing is pre-loaded — "~0 / N" alongside zero pre-loaded rows reads
// as a broken counter for owners. Returns "" on the empty collection so
// the EmptyState above doesn't stack with a redundant "0 documents …"
// line; the JSX guards with truthiness.
function footerCopy({
  memberCount,
  coreCount,
  referenceCount,
  totalTokens,
  budget,
}: Readonly<{
  memberCount: number;
  coreCount: number;
  referenceCount: number;
  totalTokens: number;
  budget: number;
}>): string {
  if (memberCount === 0) return "";
  const tokens = `~${formatNumber(totalTokens)} / ${formatNumber(budget)} tokens`;
  if (coreCount === 0) {
    return `${pluralize(memberCount, "document")} available on demand — nothing pre-loaded.`;
  }
  if (referenceCount === 0) {
    return `${pluralize(coreCount, "document")} always included (${tokens}).`;
  }
  return `${pluralize(coreCount, "document")} always included (${tokens}) · ${String(referenceCount)} more available on demand.`;
}

// The left pane of the collection page: what the agent actually gets.
// Sized to its content; the footer restates the assembled result right
// under the list so the content has a bottom of its own (no stretching,
// no stranded footer).
export function CollectionMembers({
  slug,
  projectId,
  budget,
  direct,
  viaFolder,
  linkedFolders,
}: Readonly<{
  slug: CollectionSlug;
  projectId: ProjectId;
  budget: number;
  direct: readonly ColMemberRow[];
  viaFolder: readonly ColMemberRow[];
  linkedFolders: readonly ColFolderLink[];
}>): React.ReactElement {
  const router = useRouter();
  const [order, setOrder] = useState<readonly ColMemberRow[]>(direct);
  const dragFrom = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const { error, run } = useSubmit(
    async (fn: () => Promise<{ ok: boolean }>) => {
      const r = await fn();
      if (!r.ok) throw new Error("That didn’t take — please retry.");
      await router.invalidate();
    },
  );

  function persistOrder(next: readonly ColMemberRow[]) {
    setOrder(next);
    void run(() =>
      reorderCollectionDocuments({
        data: {
          projectId,
          collectionSlug: slug,
          orderedDocumentSlugs: next.map((m) => m.slug),
        },
      }),
    );
  }

  function onDrop(to: number) {
    const from = dragFrom.current;
    dragFrom.current = null;
    setDragOver(null);
    if (from === null || from === to) return;
    const next = [...order];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return;
    next.splice(to, 0, moved);
    persistOrder(next);
  }

  function detach(m: ColMemberRow) {
    void run(() =>
      detachDocument({
        data: { projectId, collectionSlug: slug, documentSlug: m.slug },
      }),
    );
  }

  function setDocumentDelivery(m: ColMemberRow, delivery: Delivery) {
    void run(() =>
      setMemberDelivery({
        data: {
          projectId,
          collectionSlug: slug,
          documentSlug: m.slug,
          delivery,
        },
      }),
    );
  }

  function setFolderDelivery(f: ColFolderLink, delivery: Delivery) {
    void run(() =>
      setFolderLinkDelivery({
        data: {
          projectId,
          collectionSlug: slug,
          folderSlug: f.slug,
          delivery,
        },
      }),
    );
  }

  const byFolder = useMemo(() => {
    const m = new Map<FolderSlug, ColMemberRow[]>();
    for (const row of viaFolder) {
      if (row.viaFolder === undefined) continue;
      const list = m.get(row.viaFolder) ?? [];
      list.push(row);
      m.set(row.viaFolder, list);
    }
    return m;
  }, [viaFolder]);

  // One pass over every member instead of two spreads + two filters —
  // delivered is reused for the token sum; coreCount falls out of it.
  const memberCount = order.length + viaFolder.length;
  const delivered: ColMemberRow[] = [];
  for (const m of order) if (m.delivery === "core") delivered.push(m);
  for (const m of viaFolder) if (m.delivery === "core") delivered.push(m);
  const coreCount = delivered.length;
  const referenceCount = memberCount - coreCount;
  const totalTokens = manifestTokens(delivered);
  const footer = footerCopy({
    memberCount,
    coreCount,
    referenceCount,
    totalTokens,
    budget,
  });

  return (
    <div className="space-y-6">
      <Section
        label="In this collection"
        count={memberCount}
        tone="primary"
        hint={
          memberCount === 0
            ? undefined
            : "“Always include” pre-loads a document into every read_collection call. Others stay in the outline and the agent pulls them on demand."
        }
      >
        {error && <p className="mb-2 text-base text-red-600">{error}</p>}
        {memberCount === 0 ? (
          <EmptyState>
            Nothing here yet — use &ldquo;Add to this collection&rdquo; below.
          </EmptyState>
        ) : (
          <ol className={listSurface("divide-y divide-slate-200")}>
            {order.map((m, i) => {
              const dragProps = {
                draggable: true,
                onDragStart: () => {
                  dragFrom.current = i;
                },
                onDragOver: (e: React.DragEvent) => {
                  e.preventDefault();
                  if (dragOver !== i) setDragOver(i);
                },
                onDrop: () => onDrop(i),
                onDragEnd: () => {
                  dragFrom.current = null;
                  setDragOver(null);
                },
              };
              return (
                <li
                  key={m.slug}
                  {...dragProps}
                  className={dragOver === i ? "bg-blue-50" : ""}
                >
                  <DocLine
                    title={m.title}
                    meta={docMeta(m)}
                    leading={
                      <span className="flex shrink-0 items-center gap-2">
                        <GripVertical
                          className="size-4 cursor-grab text-slate-400"
                          aria-hidden
                        />
                        <span className="w-5 text-right text-sm tabular-nums text-slate-400">
                          {i + 1}
                        </span>
                      </span>
                    }
                    trailing={
                      <span className="flex shrink-0 items-center gap-1">
                        <DeliveryToggle
                          value={m.delivery}
                          label={`Always include ${m.title} in read_collection`}
                          onChange={(delivery) =>
                            setDocumentDelivery(m, delivery)
                          }
                        />
                        <RemoveAction
                          label={`Remove ${m.title} from this collection`}
                          onClick={() => detach(m)}
                        />
                      </span>
                    }
                  />
                </li>
              );
            })}
          </ol>
        )}
      </Section>

      {linkedFolders.length > 0 && (
        <Section
          label="Folders in this collection"
          hint="Live — documents added to these folders join automatically. Manage them by the folder, not one by one."
        >
          <div className="space-y-3">
            {linkedFolders.map((f) => (
              <FolderMembersSection
                key={f.slug}
                folder={f}
                members={byFolder.get(f.slug) ?? []}
                delivery={f.delivery}
                onDeliveryChange={(delivery) => setFolderDelivery(f, delivery)}
                onUnlink={() =>
                  void run(() =>
                    detachFolderFromCollection({
                      data: {
                        projectId,
                        collectionSlug: slug,
                        folderSlug: f.slug,
                      },
                    }),
                  )
                }
              />
            ))}
          </div>
        </Section>
      )}

      {footer && (
        <p className="border-t border-slate-200 pt-4 text-sm tabular-nums text-slate-500">
          {footer}
        </p>
      )}
    </div>
  );
}

// The folder-link accordion inside the members pane: a folder header
// with delivery + unlink trailing actions, then its current resolved
// members rendered read-only (the folder is the unit; per-document
// actions belong to the folder owner, not the collection builder).
function FolderMembersSection({
  folder,
  members,
  delivery,
  onDeliveryChange,
  onUnlink,
}: Readonly<{
  folder: ColFolderLink;
  members: readonly ColMemberRow[];
  delivery: Delivery;
  onDeliveryChange: (delivery: Delivery) => void;
  onUnlink: () => void;
}>) {
  return (
    <div className={listSurface()}>
      <div className="border-b border-slate-200 bg-slate-50">
        <FolderLine
          name={folder.name}
          count={members.length}
          trailing={
            <span className="flex shrink-0 items-center gap-1">
              <DeliveryToggle
                value={delivery}
                label={`Always include folder ${folder.name} in read_collection`}
                onChange={onDeliveryChange}
              />
              <RemoveAction
                label={`Remove folder ${folder.name} from this collection`}
                onClick={onUnlink}
              />
            </span>
          }
        />
      </div>
      {members.length === 0 ? (
        <p className="px-3 py-2.5 text-sm text-slate-400">Empty for now.</p>
      ) : (
        <div className="divide-y divide-slate-200">
          {members.map((m) => (
            <DocLine key={m.slug} title={m.title} meta={docMeta(m)} />
          ))}
        </div>
      )}
    </div>
  );
}
