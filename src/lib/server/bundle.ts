import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { connectControlDb } from "@/control/db";
import { projectSlugs } from "@/control/project-admin";
import { projectMiddleware } from "@/lib/middleware";
import { requireProjectOwner, storeOf } from "@/lib/server/shared";
import { assertServerContext as srv } from "@/lib/server-context";
import type { ImportResult as DoImportResult } from "@/project-store";
import { type Bundle, parseBundle } from "@/store/domain/bundle";

// Server-fn ImportResult = the DO's outcomes (root-hash check + ok)
// plus the parse-time variants `parseBundle` produces before the DO is
// ever invoked. The DO type stays narrow; only this seam unions both.
export type ImportResult = Readonly<
  | DoImportResult
  | {
      ok: false;
      reason: "version-mismatch";
      got: string;
      expected: string;
    }
  | { ok: false; reason: "invalid-bundle-shape"; details: string }
>;

// Bundle export and import are admin-only. Export serializes the whole
// project (every document, version, collection, folder, manifest); import
// can replace it atomically. Both are owner-gated server-side so a
// member session can't drive them headlessly (the Settings UI is
// owner-only too, but the server fn is the trust boundary).
const BUNDLE_ADMIN_MSG =
  "Only an organization owner can export or import a project bundle";

export const exportBundle = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .handler(async ({ context }): Promise<Bundle> => {
    const c = srv(context);
    const ref = requireProjectOwner(c.project, BUNDLE_ADMIN_MSG);
    const source = await projectSlugs(connectControlDb(c.env.DB), ref);
    return storeOf(c).exportBundle(source);
  });

// Import takes `unknown` so the version/shape check can surface as a
// structured ImportResult variant (with the got/expected version pair)
// instead of a generic 400 from the input validator. `parseBundle`
// runs the preflight version extraction then the full BundleSchema.
export const importBundle = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .inputValidator(z.unknown())
  .handler(async ({ data, context }): Promise<ImportResult> => {
    const c = srv(context);
    requireProjectOwner(c.project, BUNDLE_ADMIN_MSG);

    const parsed = parseBundle(data);
    if (!parsed.ok) return parsed;
    return storeOf(c).importBundle(parsed.bundle);
  });
