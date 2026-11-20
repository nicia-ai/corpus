# Admin project stats

Per-project **structural counts** (never content, titles, slugs, paths, names
or user ids). Computed inside each project's `ProjectStore` DO
(`statsSnapshot()`), stored in D1 table `project_stats`, refreshed once a day
by the hourly cron (UTC hour `PROJECT_STATS_REFRESH_UTC_HOUR` in
`src/control/project-stats.ts`) and on demand from Admin → Projects →
Structure → "Refresh now" (platform admin only, writes an `admin_audit` row
with action `project.stats_refresh`).

Pure aggregation: `src/store/domain/project-stats.ts`. DO read:
`src/project-store/project-stats.ts`. Membership is the RESOLVED membership
(direct `includes` + folder expansion via `includes_folder`), the same
resolver every other surface uses.

## Reading it with wrangler

```sh
wrangler d1 execute <DB_NAME> --remote --command "
SELECT p.name,
       datetime(s.computed_at / 1000, 'unixepoch') AS computed,
       s.error_kind,
       s.schema_version,
       s.stats_json
FROM project_stats s JOIN project p ON p.id = s.project_id
ORDER BY p.created_at;"
```

Pull fields with SQLite JSON, e.g.:

```sh
wrangler d1 execute <DB_NAME> --remote --command "
SELECT p.name,
       json_extract(s.stats_json, '\$.documents.live')              AS live_docs,
       json_extract(s.stats_json, '\$.documents.inTwoOrMoreCorpora') AS multi_corpus_docs,
       json_extract(s.stats_json, '\$.corpora.total')               AS corpora,
       json_extract(s.stats_json, '\$.links.crossCorpus')           AS cross_corpus_links
FROM project_stats s JOIN project p ON p.id = s.project_id;"
```

`<DB_NAME>` is the `d1_databases` entry in `wrangler.jsonc`.

## Columns

| column           | meaning                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `project_id`     | PK, FK to `project.id` (cascade)                                                         |
| `schema_version` | `PROJECT_STATS_SCHEMA_VERSION` the JSON was written under; readers ignore other versions |
| `stats_json`     | last SUCCESSFUL snapshot; null if none has succeeded                                     |
| `computed_at`    | ms epoch of that success; null if none                                                   |
| `attempted_at`   | ms epoch of the latest attempt                                                           |
| `error_kind`     | `AppError` kind of the latest attempt if it failed, else null (no messages stored)       |

A failed attempt keeps the previous `stats_json`; it only sets `error_kind`
and `attempted_at`.

## `stats_json` fields

`documents` (live = non-archived; membership counts are over live documents)

- `total`, `live`, `archived`
- `inNoCorpus`, `inOneCorpus`, `inTwoOrMoreCorpora`: resolved corpus membership

`corpora`

- `total`
- `withDirectDocuments`: corpora with at least one direct document inclusion
- `withFolderInclusions`: corpora with at least one folder inclusion
- `withBothInclusionKinds`: corpora with both of the above
- `withDocumentViaBoth`: corpora where one document is included directly AND
  sits under a linked folder
- `defaultPresent`, `defaultMembers`: the `default` corpus and its member count
- `maxMembers`, `totalMembers`: over resolved members (a document in two
  corpora counts twice in the total)

`perCorpus[]`: one entry per corpus, sorted by slug, **no name or slug**

- `members`
- `distinctTopLevelFolders`, `distinctParentFolders`: where its members live
  (root-level members count toward neither)
- `membersAtRoot`: members not in any folder
- `coreMembers`, `referenceMembers`: effective delivery tier after resolution
- `orderDiffersFromLexicalPath`: resolved order is not plain lexical order of
  member paths

`folders`

- `total`, `maxDepth` (a top-level folder has depth 1), `topLevel`
- `includedByTwoOrMoreCorpora`: folders directly linked by 2+ corpora

`sameFilenamePairsAcrossCorpora`: unordered pairs of distinct live documents
with the same file name (last path segment), both in at least one corpus, and
NOT both solely in the same single corpus. These collide if each corpus gets its
own tree.

`links`: wikilinks and relative links, resolved with the same path
resolution as the corpus outline; self-links ignored.

- `resolved`: links whose target is a live document
- `crossCorpus`: resolved links where source and target are each in at least one
  corpus but share none

## Not included

- Share links (embassies) live in D1, not the DO; query `embassy` directly.
- Links to or from documents in no corpus are not counted as cross-corpus.
