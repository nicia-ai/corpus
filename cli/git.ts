import { z } from "zod";

import { CliError } from "./errors.js";
import { type ApiConfig, request } from "./http.js";

// `corpus git`: hand a read-only Git clone of the key's corpus to a person or
// an agent sandbox. The server keeps a Git mirror of each served corpus on
// Cloudflare Artifacts; the API key is exchanged for a short-lived read token
// scoped to that one repository. Pure like the rest of the core: only `fetch`
// in, strings out.

export const GIT_USAGE = `usage: corpus git clone [dir] [--helper]
       corpus git credential <get|store|erase>

  clone [dir]            Print a ready-to-run \`git clone\` (token valid ~1 hour)
  clone [dir] --helper   Print one that fetches a fresh token on every git
                         command, so \`git pull\` keeps working
  credential <op>        The git credential helper behind --helper`;

const TOKEN_PATH = "/api/v1/git/token";
const CREDENTIAL_HELPER = "!corpus git credential";
// Artifacts ignores the Basic-auth username; git wants one.
const CREDENTIAL_USERNAME = "x";
// A token's secret is the part before this marker (the suffix is its expiry).
const TOKEN_EXPIRY_MARKER = "?expires=";
const MS_PER_SECOND = 1000;
const STATUS_NOT_FOUND = 404;
const STATUS_NOT_READY = 409;

const CloneAccessSchema = z.object({
  remote: z.string().min(1),
  branch: z.string().min(1),
  token: z.string().min(1),
  expiresAt: z.string().min(1),
  current: z.boolean(),
  corpus: z.string().min(1),
});
const ErrorBodySchema = z.object({ error: z.string() });

export type CloneAccess = Readonly<z.infer<typeof CloneAccessSchema>>;

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = ErrorBodySchema.safeParse(await res.json().catch(() => null));
  return body.success ? body.data.error : fallback;
}

// Exchange the API key for a read-only clone credential.
export async function fetchCloneAccess(cfg: ApiConfig): Promise<CloneAccess> {
  const res = await request(cfg, TOKEN_PATH, { method: "POST" });
  if (res.status === STATUS_NOT_FOUND) {
    throw new CliError(
      "unsupported",
      await errorMessage(res, "this Corpus server has no Git mirror."),
      { status: res.status },
    );
  }
  if (res.status === STATUS_NOT_READY) {
    throw new CliError(
      "conflict",
      await errorMessage(res, "the Git mirror is not ready yet."),
      { status: res.status },
    );
  }
  if (!res.ok) {
    throw new CliError("http", `git token failed (${String(res.status)})`, {
      status: res.status,
    });
  }
  return CloneAccessSchema.parse(await res.json());
}

// The token without its `?expires=` suffix: what HTTP Basic auth takes as a
// password.
export function tokenSecret(token: string): string {
  const at = token.indexOf(TOKEN_EXPIRY_MARKER);
  return at === -1 ? token : token.slice(0, at);
}

// POSIX single-quoting: safe for any value, including one with a quote.
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export type CloneCommandOptions = Readonly<{
  dir?: string | undefined;
  // Fetch a fresh token on every git command instead of embedding this one.
  helper: boolean;
}>;

// A command a person or sandbox can run as-is. The default carries the token
// as an `http.extraHeader` (Artifacts' documented form), so it needs nothing
// installed beyond git; it stops working when the token expires. The helper
// form keeps the token out of the command and out of shell history, and
// configures the clone so every later `git pull` mints its own.
export function cloneCommand(
  access: CloneAccess,
  options: CloneCommandOptions,
): string {
  const dir = options.dir ?? access.corpus;
  const target = [shellQuote(access.remote), shellQuote(dir)].join(" ");
  if (options.helper) {
    return `git clone -c credential.helper=${shellQuote(CREDENTIAL_HELPER)} ${target}`;
  }
  const header = shellQuote(`Authorization: Bearer ${access.token}`);
  return (
    `git -c http.extraHeader=${header} clone ${target}` +
    ` && git -C ${shellQuote(dir)} config credential.helper ${shellQuote(CREDENTIAL_HELPER)}`
  );
}

// `key=value` lines git sends a credential helper on stdin.
export function parseCredentialRequest(
  input: string,
): ReadonlyMap<string, string> {
  const fields = new Map<string, string>();
  for (const line of input.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) fields.set(line.slice(0, at), line.slice(at + 1).trim());
  }
  return fields;
}

export type CredentialOperation = "get" | "store" | "erase";

export function isCredentialOperation(
  value: string | undefined,
): value is CredentialOperation {
  return value === "get" || value === "store" || value === "erase";
}

// The helper's reply to git, as stdout text. Only `get` answers, and only for
// the mirror's own host: git offers every credential helper every host it
// talks to, and a token for one repository must never be sent to another
// server. `store` and `erase` are no-ops — tokens are minted on demand and
// never kept.
export async function credentialReply(
  cfg: ApiConfig,
  operation: CredentialOperation,
  input: string,
): Promise<string> {
  if (operation !== "get") return "";
  const asked = parseCredentialRequest(input);
  const access = await fetchCloneAccess(cfg);
  const mirror = new URL(access.remote);
  const askedProtocol = asked.get("protocol");
  const askedHost = asked.get("host");
  if (
    askedProtocol !== mirror.protocol.replace(":", "") ||
    askedHost !== mirror.host
  ) {
    return "";
  }
  const expiry = Math.floor(Date.parse(access.expiresAt) / MS_PER_SECOND);
  return [
    `username=${CREDENTIAL_USERNAME}`,
    `password=${tokenSecret(access.token)}`,
    ...(Number.isNaN(expiry) ? [] : [`password_expiry_utc=${String(expiry)}`]),
    "",
  ].join("\n");
}
