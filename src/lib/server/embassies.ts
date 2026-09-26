import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { connectControlDb } from "@/control/db";
import {
  listEmbassiesForDocument,
  mintEmbassy,
  resolveLiveEmbassy,
  revokeEmbassy as revokeEmbassyRow,
  revokeEmbassiesForDocument,
  setEmbassyGrant,
  setEmbassyLabel,
  type EmbassyView,
} from "@/control/embassies";
import { entitlementsOf } from "@/control/entitlements";
import { EMBASSY_GRANTS, type EmbassyGrant } from "@/embassy/grant";
import { ValidationError } from "@/errors";
import { asDocumentSlug, asEmbassyId } from "@/ids";
import { projectMiddleware } from "@/lib/middleware";
import { changedBy, requireProjectOwner, storeOf } from "@/lib/server/shared";
import { assertServerContext as srv } from "@/lib/server-context";
import { compact, slugify, utf8Bytes } from "@/util";

const EMBASSY_ADMIN_MSG = "Only an organization owner can share a document";

export type EmbassyDto = Readonly<{
  id: string;
  documentSlug: string;
  label: string;
  grant: EmbassyGrant;
  expiresAt: number;
  fetchCount: number;
}>;

export type EmbassyList = Readonly<{
  rows: readonly EmbassyDto[];
  served: boolean;
}>;

function toDto(row: EmbassyView): EmbassyDto {
  return {
    id: row.id,
    documentSlug: row.documentSlug,
    label: row.label,
    grant: row.grant,
    expiresAt: row.expiresAt,
    fetchCount: row.fetchCount,
  };
}

export const listEmbassies = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .validator(z.object({ slug: z.string().min(1) }))
  .handler(async ({ data, context }): Promise<EmbassyList> => {
    const c = srv(context);
    const ref = requireProjectOwner(c.project, EMBASSY_ADMIN_MSG);
    const slug = asDocumentSlug(data.slug);
    const [rows, served] = await Promise.all([
      listEmbassiesForDocument(connectControlDb(c.env.DB), ref.projectId, slug),
      storeOf(c).isDocumentServed(slug),
    ]);
    return { rows: rows.map(toDto), served };
  });

export const createEmbassy = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(
    z.object({
      slug: z.string().min(1),
      label: z.string().trim().min(1).max(80),
      grant: z.enum(EMBASSY_GRANTS),
    }),
  )
  .handler(async ({ data, context }): Promise<EmbassyDto> => {
    const c = srv(context);
    const ref = requireProjectOwner(c.project, EMBASSY_ADMIN_MSG);
    const slug = asDocumentSlug(data.slug);
    const doc = await storeOf(c).getDocument(slug);
    if (doc === undefined) throw new ValidationError("Document not found");
    if (data.grant === "edit" && (await storeOf(c).isDocumentServed(slug))) {
      throw new ValidationError(
        "A document served by a corpus can receive suggestions, not direct edits",
      );
    }
    const row = await mintEmbassy(connectControlDb(c.env.DB), {
      projectId: ref.projectId,
      documentSlug: slug,
      label: data.label,
      grant: data.grant,
    });
    return toDto(row);
  });

export const changeEmbassyGrant = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(
    z.object({
      embassyId: z.string().min(1),
      grant: z.enum(EMBASSY_GRANTS),
    }),
  )
  .handler(async ({ data, context }): Promise<EmbassyDto> => {
    const c = srv(context);
    const ref = requireProjectOwner(c.project, EMBASSY_ADMIN_MSG);
    const id = asEmbassyId(data.embassyId);
    const existing = await resolveLiveEmbassy(connectControlDb(c.env.DB), id);
    if (existing?.projectId !== ref.projectId) {
      throw new ValidationError("This link was revoked or has expired");
    }
    if (
      data.grant === "edit" &&
      (await storeOf(c).isDocumentServed(existing.documentSlug))
    ) {
      throw new ValidationError(
        "A document served by a corpus can receive suggestions, not direct edits",
      );
    }
    const row = await setEmbassyGrant(connectControlDb(c.env.DB), {
      id,
      projectId: ref.projectId,
      grant: data.grant,
    });
    if (row === undefined)
      throw new ValidationError("This link was revoked or has expired");
    return toDto(row);
  });

export const renameEmbassy = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(
    z.object({
      embassyId: z.string().min(1),
      label: z.string().trim().min(1).max(80),
    }),
  )
  .handler(async ({ data, context }): Promise<EmbassyDto> => {
    const c = srv(context);
    const ref = requireProjectOwner(c.project, EMBASSY_ADMIN_MSG);
    const row = await setEmbassyLabel(connectControlDb(c.env.DB), {
      id: asEmbassyId(data.embassyId),
      projectId: ref.projectId,
      label: data.label,
    });
    if (row === undefined)
      throw new ValidationError("This link was revoked or has expired");
    return toDto(row);
  });

export const revokeEmbassy = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(z.object({ embassyId: z.string().min(1) }))
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const c = srv(context);
    const ref = requireProjectOwner(c.project, EMBASSY_ADMIN_MSG);
    await revokeEmbassyRow(connectControlDb(c.env.DB), {
      id: asEmbassyId(data.embassyId),
      projectId: ref.projectId,
    });
    return { ok: true };
  });

export const unshareDocument = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(z.object({ slug: z.string().min(1) }))
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const c = srv(context);
    const ref = requireProjectOwner(c.project, EMBASSY_ADMIN_MSG);
    await revokeEmbassiesForDocument(connectControlDb(c.env.DB), {
      projectId: ref.projectId,
      documentSlug: asDocumentSlug(data.slug),
    });
    return { ok: true };
  });

export const createIntake = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(z.object({ title: z.string().trim().min(1).max(200) }))
  .handler(
    async ({
      data,
      context,
    }): Promise<
      Readonly<{ slug: string; embassy: EmbassyDto | undefined }>
    > => {
      const c = srv(context);
      const ref = requireProjectOwner(c.project, EMBASSY_ADMIN_MSG);
      const slug = asDocumentSlug(slugify(data.title));
      await entitlementsOf(c).assertWithinQuota({
        action: "document_create",
        userId: ref.userId,
        organizationId: ref.organizationId,
        projectId: ref.projectId,
        amount: 1,
        bytes: utf8Bytes(""),
      });
      const saved = await storeOf(c).saveDocument(
        compact({
          slug,
          title: data.title,
          markdown: "",
          clientVersion: 0,
          changedBy: changedBy(c),
        }),
      );
      if (!saved.ok) {
        throw new ValidationError(
          "conflict" in saved
            ? "A document with this title already exists."
            : "Could not create intake document",
        );
      }
      try {
        const embassy = await mintEmbassy(connectControlDb(c.env.DB), {
          projectId: ref.projectId,
          documentSlug: slug,
          label: "Intake draft",
          grant: "edit",
        });
        return { slug, embassy: toDto(embassy) };
      } catch {
        // The ProjectStore write has committed. Return the partial success so
        // the owner can open the page and create a link from Share.
        return { slug, embassy: undefined };
      }
    },
  );
