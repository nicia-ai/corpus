-- Better Auth 1.7 account-identity backfill (see
-- https://better-auth.com/docs/guides/1-7-upgrade-guide#account-identity-is-scoped-by-issuer).
-- `account.issuer` was added nullable by 0001; this fills it in per the
-- upgrade guide's provider mapping before 0004 makes it NOT NULL and adds
-- the `(issuer, account_id)` unique index. `account_id` is untouched —
-- Corpus never renamed it and credential accounts already store the
-- linked user's stable id there.
--
-- `local:oauth:<providerId>` is the guide's synthetic-issuer fallback for
-- an OAuth provider with no real issuer. It's supposed to be
-- `encodeURIComponent(providerId)`; a bare concatenation is exact here only
-- because every providerId Corpus configures (`credential`, `google`) is a
-- plain identifier with nothing to percent-encode. Reassess if a future
-- provider id needs escaping.
UPDATE `account`
SET `issuer` = CASE `provider_id`
  WHEN 'credential' THEN 'local:credential'
  WHEN 'google' THEN 'https://accounts.google.com'
  ELSE 'local:oauth:' || `provider_id`
END
WHERE `issuer` IS NULL;
