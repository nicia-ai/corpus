import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { connectControlDb } from "@/control/db";
import {
  listEmbassiesForDocument,
  mintEmbassy,
  revokeEmbassy as revokeEmbassyRow,
  revokeEmbassiesForDocument,
  type EmbassyView,
} from "@/control/embassies";
import { entitlementsOf } from "@/control/entitlements";
import type { EmbassyGrant } from "@/embassy/grant";
import { isIntakeMarkdown } from "@/embassy/intake";
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
  grant: EmbassyGrant;
  expiresAt: number;
  fetchCount: number;
}>;

function toDto(row: EmbassyView): EmbassyDto {
  return {
    id: row.id,
    documentSlug: row.documentSlug,
    grant: row.grant,
    expiresAt: row.expiresAt,
    fetchCount: row.fetchCount,
  };
}

export const listEmbassies = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .validator(z.object({ slug: z.string().min(1) }))
  .handler(async ({ data, context }): Promise<readonly EmbassyDto[]> => {
    const c = srv(context);
    const ref = requireProjectOwner(c.project, EMBASSY_ADMIN_MSG);
    const rows = await listEmbassiesForDocument(
      connectControlDb(c.env.DB),
      ref.projectId,
      asDocumentSlug(data.slug),
    );
    return rows.map(toDto);
  });

export const createEmbassy = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(
    z.object({
      slug: z.string().min(1),
      grant: z.enum(["read", "suggest", "replace"]),
    }),
  )
  .handler(async ({ data, context }): Promise<EmbassyDto> => {
    const c = srv(context);
    const ref = requireProjectOwner(c.project, EMBASSY_ADMIN_MSG);
    const slug = asDocumentSlug(data.slug);
    const doc = await storeOf(c).getDocument(slug);
    if (doc === undefined) throw new ValidationError("Document not found");
    if (data.grant === "replace" && !isIntakeMarkdown(doc.markdown)) {
      throw new ValidationError("Replace is only for empty intake pages");
    }
    const row = await mintEmbassy(connectControlDb(c.env.DB), {
      projectId: ref.projectId,
      documentSlug: slug,
      grant: data.grant,
    });
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
    }): Promise<Readonly<{ slug: string; embassy: EmbassyDto }>> => {
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
      const embassy = await mintEmbassy(connectControlDb(c.env.DB), {
        projectId: ref.projectId,
        documentSlug: slug,
        grant: "replace",
      });
      return { slug, embassy: toDto(embassy) };
    },
  );
