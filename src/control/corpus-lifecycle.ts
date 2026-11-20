import type { CorpusSlug, DocumentSlug, ProjectId } from "../ids";
import type {
  DeleteCorpusInput,
  DeleteCorpusResult,
} from "../project-store/contracts";
import { corpusIsServed } from "../store/domain/corpus-drive";

import { deleteConnectionsForCorpus } from "./connections";
import type { ControlDb } from "./db";
import { revokeEmbassiesForDocuments } from "./embassies";

// The three ProjectStore calls this module makes, as plain function types
// (the Durable Object stub satisfies them; a test can supply a stand-in).
export type CorpusStoreDoor = Readonly<{
  deleteCorpus: (input: DeleteCorpusInput) => Promise<DeleteCorpusResult>;
  corpusMeta: (slug: CorpusSlug) => Promise<Readonly<{ found: boolean }>>;
  createCorpus: (
    input: Readonly<{
      slug: CorpusSlug;
      name: string;
      description?: string;
      changedBy: string;
    }>,
  ) => Promise<Readonly<{ slug: CorpusSlug }>>;
}>;

export type CorpusDeleteOutcome = Readonly<
  | { ok: true; archivedSlugs: readonly DocumentSlug[]; moved: number }
  | { ok: false; reason: "missing" | "default-corpus" }
>;

// Delete a corpus and everything in the control plane that points at it.
//
// The order is the point. The ProjectStore goes FIRST: if it throws, the
// corpus is still live and so are its credentials — never a live corpus
// that agents can no longer reach. Credentials go second, and
// unconditionally (they are scoped by project + slug, so this is safe even
// when the corpus is already gone, which also finishes an earlier delete that
// died between the two steps). A credential that outlived a failed second
// step cannot be inherited by a later corpus reusing the slug, because
// `createCorpusClean` purges them before creating. The default corpus
// (Drafts) is refused before anything is touched.
export async function deleteCorpusAndCredentials(
  args: Readonly<{
    db: ControlDb;
    store: CorpusStoreDoor;
    projectId: ProjectId;
    input: DeleteCorpusInput;
  }>,
): Promise<CorpusDeleteOutcome> {
  const { db, store, projectId, input } = args;
  if (!corpusIsServed(input.slug)) {
    return { ok: false, reason: "default-corpus" };
  }
  const result = await store.deleteCorpus(input);
  await deleteConnectionsForCorpus(db, { projectId, corpusSlug: input.slug });
  if (!result.ok) return result;
  await revokeEmbassiesForDocuments(db, {
    projectId,
    documentSlugs: result.archivedSlugs,
  });
  return result;
}

// Create a corpus that starts with no credentials. A slug that is free in
// the project but still has Connections (a delete that never finished its
// control-plane half) must not hand them to the new corpus.
export async function createCorpusClean(
  args: Readonly<{
    db: ControlDb;
    store: CorpusStoreDoor;
    projectId: ProjectId;
    corpus: Parameters<CorpusStoreDoor["createCorpus"]>[0];
  }>,
): Promise<{ slug: CorpusSlug }> {
  const { db, store, projectId, corpus } = args;
  if (!(await store.corpusMeta(corpus.slug)).found) {
    await deleteConnectionsForCorpus(db, {
      projectId,
      corpusSlug: corpus.slug,
    });
  }
  return store.createCorpus(corpus);
}
