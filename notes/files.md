# Images and attachments

Background for the file-storage rules in `AGENTS.md`. This is the design as it
was built in the first PR (storage, upload, in-app rendering, sweep); what is
deliberately not built yet is listed at the end.

## Shape

- **Bytes in R2, metadata in the DO.** The `FILES` R2 binding holds the bytes,
  content-addressed under the project: `p/<projectId>/<sha256hex>`. A `File`
  node in the project's graph holds the metadata (`slug`, `filename`,
  `contentHash`, `contentType`, `size`, `createdAt`, `deletedAt?`) and a
  `file_in_folder` edge puts it in a folder.
- **Why a node, not a side table.** A file's name competes with documents and
  folders for one path segment under its parent. `FolderRepo.siblingSegments`
  already models that cross-type namespace; `SiblingKind` gained `"file"`, so a
  page, a folder and a file can never share a name, with no second mechanism.
  A file's corpus is its folder ancestry's root, so "one corpus per file" holds
  by construction.
- **Head-only.** There is no file version chain. Bytes are immutable and
  content-addressed; replacing a file would move `contentHash`. History of
  images is a non-goal for v1, which keeps `verify.ts` and the bundle
  untouched.
- **Optional, like the Git mirror.** No binding means the feature is off: the
  upload route answers 404 "not enabled", the editor shows no upload controls,
  and nothing logs an error. `objectStoreFor(env)` (`src/files/object-store-for.ts`)
  is the single place the binding is resolved; `setObjectStoreForTest` is its
  test seam.

## Tenant isolation

The R2 key is built from a `ProjectId` the caller was already authorized for
(`resolveProjectById`, or `storeFor(env, projectId)`), so a key for another
project cannot be constructed from a session that does not belong to it. Dedupe
is project-local, so no response can reveal that another project holds a file.
The serving route additionally asks THIS project's DO whether it holds a live
file with the hash. Keeper: `test/files/file-cross-tenant.test.ts`.

## Upload

`PUT /api/files?project=<id>&document=<slug>[&name=<name>]`, raw body
(`src/files/http.ts`, mounted in `src/api.ts`). It lands next to the page: the
DO resolves the page's folder inside the same transaction that writes the
metadata (`attachFileCommand`).

1. Same-origin check (`src/lib/same-origin.ts`). Hono routes bypass the CSRF
   middleware `src/start.tsx` adds for server functions, so this route applies
   the same rule itself: `Sec-Fetch-Site` must be `same-origin`, else `Origin`
   must equal the request origin, else `Referer`; none of the three is a
   refusal.
2. Session and project membership. Only someone who can edit the page can
   upload (every member). Suggest-grant credentials cannot, in v1.
3. `Content-Length` over the cap is refused before reading; the body is read
   with a running count, so a missing or lying length cannot buffer past it.
4. `judgeUpload` (`src/store/domain/file-kinds.ts`, pure): the type comes from
   **magic bytes**, never the client; a name must carry an extension for that
   same type; an SVG must pass `svgProblem`.
5. **Bytes first, metadata second.** `FILES.put` always runs, even if the key
   exists, then `attachFile` commits the node, the edge and the `file.created`
   event in one `write()` transaction. Never the reverse: metadata without
   bytes is a file a person can see and cannot open; bytes without metadata are
   an orphan the sweep removes. Re-putting refreshes `uploaded`, which the
   sweep's grace window keys on; a `head` followed by skipping the put could
   race the sweep. Keeper: `test/files/file-upload.test.ts`.

Dedupe: the same bytes in the same folder return the existing file (a double
paste, a retry after a lost response). A nameless upload is named
`pasted-<first 8 hex>.<ext>`. A different file with a taken name becomes
`name-2.ext`; the response says what it ended up called, because the link must
use that. Names are normalized to letters, digits, `.`, `_`, `-` (anything else
becomes `-`), so a name is a bare link destination that never needs escaping.

Limits are named constants in `src/util.ts`: `MAX_FILE_BYTES` (10 MiB) and
`MAX_PROJECT_FILE_BYTES` (1 GiB). The quota is checked in the DO, inside the
attach transaction, against `SUM(size)` of live files, because the DO is where
the total is exact. The hosted entitlements port gets a `file_upload` action
too (`assertWithinQuota`, called after sniffing and before the put), which is
approximate by design like its siblings.

### SVG: three layers

1. `svgProblem` refuses script, event-handler attributes, `javascript:` (after
   decoding numeric entities and stripping whitespace), `foreignObject`,
   embedded documents, entity declarations (a DOCTYPE with an internal subset
   is not even recognized as SVG), `@import`, and any `href`, `xlink:href` or
   CSS `url()` that is not `#local` or an embedded raster `data:` image.
2. Served with `Content-Security-Policy: default-src 'none'; style-src
'unsafe-inline'; sandbox`.
3. Served `Content-Disposition: attachment` unless `Sec-Fetch-Dest: image`, so
   navigating to one never renders it in the app origin. PDFs are always
   attachments.

## Serving

`GET /api/files/:projectId/:hash`: session, membership, then the DO's
`fileByHash`. `Content-Type` comes from our metadata, never R2. Headers:
`Cache-Control: private, max-age=31536000, immutable` (content-addressed),
`ETag`, `Vary: Sec-Fetch-Dest`, `X-Content-Type-Options: nosniff`,
`Cross-Origin-Resource-Policy: same-origin`, the CSP above. Keeper:
`test/files/file-serving-headers.test.ts`.

## Rendering

Markdown bytes stay canonical and are never rewritten. A page's relative
links are parsed once per content hash (the existing `links.ts` cache),
resolved against the page's corpus-relative path with `resolveRelativePath`,
and looked up as files in the same corpus. The result is the loader's
`assets` map (`documentReviewSnapshot`), keyed by the link target exactly as
written, `{url, name, contentType, size}` per entry. The editor renders from
that map and from nothing else: `image-assets.ts` holds it as CodeMirror state
(`setImageAssets` replaces it by effect; an upload adds to it locally), the
live-preview image widget and the table widget resolve through it, and a
relative target the map does not hold renders a "Missing image: name"
placeholder. There is no effect-based fetching: an `<img>` loads its own URL.
Moving a page alone away from its images breaks its links (the placeholder
shows); moving or renaming a folder does not, because the files move with it.

Editor UX: paste and drag-drop upload through `upload-state.ts` (an
`Uploading <name>…` widget at a mapped position; nothing enters the document
until the server accepts the file, and a failure inserts nothing). The
authoring controls carry an **Insert image** button (hidden without the
binding). A link to a stored non-image (a PDF) opens the file instead of
routing to a document, and the broken-link linter does not flag it.

## Retention, the sweep, the bundle

- **Reaper.** `reapExpiredRecords` gained a file step: soft-deleted files past
  `fileDays` are `hardDelete`d (per node, as `AGENTS.md` requires). A head file
  is never reaped. Absent `fileDays` means forever.
- **Orphan sweep** (`src/files/orphan-sweep.ts`), from `reconcileRetention`
  (the hourly cron), outside the DO transaction. Per project it lists
  `p/<projectId>/`, and deletes an object only when it is older than the 24 h
  grace window **and** no surviving node references its hash (soft-deleted nodes
  count). The listing is taken before the referenced set is read, and each
  candidate's age is re-checked with `head` just before it is deleted. The
  residual race (an object older than the window is re-put and committed in the
  few milliseconds between that last check and the delete) needs an orphan to be
  re-uploaded during the sweep; the consequence is a missing object for a file
  whose upload just succeeded, so a person re-adding it fixes it. Deleting a
  project deletes its whole prefix (`reconcileProjects`). Keeper:
  `test/files/file-orphan-sweep.test.ts`, with the `nowMs` seam.
- **Bundle.** `src/store/domain/bundle.ts` is an external contract and is not
  touched. Export and import ignore `File` nodes. The export server fn returns a
  sidecar `excludedFiles` count outside the contract; Settings shows "N images
  and attachments were not included". Import leaves relative links dangling.
  Needs sign-off from the contract's maintainers if images should travel in a
  bundle.

## Migration

`File` and `file_in_folder` are additive: `ensureStore()` self-heals them on
boot. `test/graph-schema-upgrade.test.ts` has the hop: storage provisioned by
the previous TypeGraph release with a graph that lacks `File`, reopened by the
current graph, then a file attached. No ledger table was needed (metadata is
graph-resident; `file.*` change events are new rows in `change_events`), so
`check:do-migrations` is unchanged and no Durable Object migration entry was
added.

## Change events

`file.created`, `file.moved`, `file.replaced` and `file.deleted`
(`FILE_EVENT_TYPES`, `src/store/domain/change-events.ts`), each naming
`corpusSlug`, because every consumer thinks per corpus. They go to the local
`change_events` ledger only (the instrumentation stream has no file
vocabulary), and `ProjectGitMirror.record` enrolls the corpus on each of them
(both corpora for a move across corpora). `file.replaced` carries the before
and after hashes: it is a head edit (same slug, new bytes) made by a REST or
CLI write with a matching `If-Match`.

## Deviations from the first design, and why

- **Wrangler placement.** The design put the `FILES` binding at the top level.
  A top-level `r2_buckets` entry makes `wrangler deploy` fail for anyone who has
  not created the bucket, which contradicts "absent binding means off,
  self-hosters unaffected". It follows the `ARTIFACTS` precedent instead: the
  binding is declared only in test environments (`env.files` for the new `files`
  vitest project, and `env.mirror` for later mirror-plus-files tests), and a
  deployment adds it to its own top level.
- **Upload addressing.** The design said `corpus`, `folder` and `name` query
  parameters. The route takes `project` and `document` instead: "lands next to
  the page" is then resolved server-side inside the transaction, with the
  membership check already scoped to the project. Path-addressed writes belong
  to the REST/CLI work.
- **No `unsafePathProblem` on the server.** It lives in `cli/sync-state.ts` and
  `src/` must not import CLI code. A file name is one segment, so
  `normalizeFileName` makes it a safe one by construction; the full
  path-safety check applies where whole paths are accepted.
- **Entitlements.** `entitlementsForRequest` exists (`src/control/entitlements.ts`);
  `file_upload` was added to its action union. The 1 GiB quota is the OSS
  default enforced in the DO.

## Git mirror, CLI and REST

The third piece: files in the mirror, in `pull --all` / `push --all`, and the
key-authenticated REST routes both use.

- **One tree.** `mirrorManifest` takes files beside documents; a file is a
  `.corpus.json` `assets` entry (`path`, `slug`, `sha256`, `size`) and a blob at
  its path. The state stays `version: 1`: `assets` is an optional array, the
  schema is not strict, so an old CLI parses new state and a new CLI parses old
  state. An old CLI's `pull --all` rewrites state without `assets`; the new CLI
  then re-matches the files on disk by hash and uploads nothing. `serializeState`
  omits an empty `assets`, so a corpus without files is byte-identical to before.
  Keeper: `test/cli-assets.test.ts` (state in both directions, with a copy of the
  previous schema), `test/mirror/files.test.ts` (mirror tree equals `pull --all`
  tree, binaries included).
- **Bounded commits.** `chunkPlan` (pure) splits a plan into sequential commits
  of about `MIRROR_CHUNK_BYTES` (16 MiB) of raw file content. Documents are not
  weighed (they are bounded by their own cap and always went together): the first
  commit carries every document and removal plus as many images as fit, the rest
  follow in path order. Each commit's `.corpus.json` is the previous state plus
  the commits so far. The pass pushes ONE chunk per loop and re-plans from the
  repository's new head, so there is no stale plan to finish after a failure or a
  concurrent change; after a non-final commit `MirrorStateRepo.recordPushed`
  moves `lastCommit`, otherwise a crash two commits in would make the head look
  foreign (`isExpected` tolerates only one commit of lag) and trigger a rebuild.
  `MAX_PASS_COMMITS` bounds a plan that stops shrinking.
  `setMirrorChunkBytesForTest` is the test seam for a small budget.
- **Stored blocks for images.** `buildPack` writes a PNG, JPEG, GIF, WebP or
  AVIF blob as zlib stored blocks (`storeDeflate`) instead of deflating it
  again; text, SVG and PDF are still deflated. Chosen from the bytes
  (`isAlreadyCompressed`, the sniffer), so `tree-edit.ts` is unchanged.
- **Over the cap.** A file over `MIRROR_MAX_FILE_BYTES` (the upload cap) goes to
  `skipped`, with the documents whose paths are unsafe. Bytes are fetched from
  R2 one file at a time and checked against the recorded size and hash before
  they are committed. A corpus with files but no `FILES` binding fails the pass
  with a clear message instead of dropping the images.
- **REST** (`src/files-rest.ts`, mounted beside `docsRoutes`): list, download
  (hash-verified, `cache-control: private, no-cache`, since a slug names a file
  that can be replaced), `PUT ?path=` with `If-Match` (create when absent), delete
  (optional `If-Match`), and move (rename within the corpus, keeping the slug).
  Reads need `read`; writes need `edit`. A `suggest` key gets the standard
  `grant_too_low` 403 ("needs edit access ... cannot be proposed"). The server's
  `judgeUpload`, body cap and entitlements check are the upload route's own
  (exported from `src/files/http.ts`, not duplicated). A path's last segment must
  already be a name the server would keep; silently renaming it would leave the
  caller tracking a path that does not exist. The commands re-check inside the
  write that the file is in the key's corpus (`src/project-store/commands/corpus-files.ts`).
  Without the `FILES` binding the routes answer 404 `files_not_enabled`, which a
  sync reads as "this server carries no images".
- **CLI push.** Untracked allowlisted files are uploaded; a changed tracked file
  is replaced with `If-Match` its synced hash; a mismatch (412) is a conflict that
  is left alone while the run continues, as for a page. Local deletions follow the
  page rules: removed with `edit` unless upstream changed it since (a conflict),
  `removal-needs-edit` with `suggest`. A deleted file plus a new one with the
  same hash is a move. The plan holds hashes only; bytes are read again just
  before each send. `cli/asset-kinds.ts` mirrors the server's allowlist and cap
  (a test fails if they drift).
- **`pull --all` and the section 6 design.** The design's "same guard as docs"
  held, but two things were not in it. Downloads run after the page writes (one
  file at a time, so memory stays flat), so the state file is written in a
  `finally` that records what finished. And a server whose listing route is
  missing or disabled (404) means "images not carried": the tracked assets are
  kept and nothing is removed, since reading the 404 as an empty listing would
  delete every tracked image.

## Share links

`GET /s/:token/f/:hash` (`embassyFile` in `src/embassy/http.ts`). Authorization
is the live embassy (`resolveLiveEmbassy`: revoked and expired are 404) plus
`ProjectStore.pageFileByHash(slug, hash)`: the hash must be in the set
`pageFileRefsProjection` resolves from the page's CURRENT head, the same
resolution the app's `assets` map uses (`documentAssetsProjection` now maps
that set to `/api/files` URLs). Recomputed per request, so a dropped image
stops being served. Headers are `fileResponseHeaders` with
`cacheControl: FILE_CACHE_SHARE_LINK` (`private, max-age=300`, not
immutable, so revocation bites). The only share-link surface is the
server-rendered HTML (`embassyPageHtml`): the writable view is a plain
`<textarea>`, not CodeMirror, so there is no editor `assets` map to build and
no upload control. The HTML builds its own `ImageAssets` of token URLs and
renders through `MarkdownContent`. Keeper: `test/embassy-files.test.ts`.
