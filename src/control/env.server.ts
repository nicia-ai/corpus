import { z } from "zod";

import type { SidebarLink } from "./env";

// An optional secret sourced from a Worker binding. An unset binding
// arrives as `undefined`; an empty/whitespace value is a self-hoster who
// left the var blank — both mean "absent", never a validation failure.
const optionalSecret = z
  .string()
  .trim()
  .optional()
  .transform((s) => (s === "" ? undefined : s));

// An optional link rendered in the sidebar footer (Docs, Help). `external`
// means "open in a new tab with an external-link glyph" — an off-site URL,
// or the same-origin docs site that lives outside the app SPA. A mailto:
// stays in place (external: false).
const EmailProviderSchema = z.enum(["cloudflare", "resend"]);

export type EmailProvider = z.infer<typeof EmailProviderSchema>;

export type EmailConfig = Readonly<{
  provider: EmailProvider | undefined;
  from: string | undefined;
  resendApiKey: string | undefined;
}>;

// A set-but-invalid EMAIL_PROVIDER is dropped with a warning, never a
// startup/request failure — matching resolveSupport/resolveDocs. The provider
// only disambiguates when both backends are configured, so an unrecognized
// value falls through to auto-detection. Failing hard here would be uniquely
// dangerous: getAuth resolves the env on every request, so one typo would 500
// every authenticated route, not just invites.
function resolveEmailProvider(
  value: string | undefined,
): EmailProvider | undefined {
  if (value === undefined) return undefined;
  const parsed = EmailProviderSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  console.warn(
    `[email] ignoring EMAIL_PROVIDER (not "cloudflare" or "resend"): ${value}`,
  );
  return undefined;
}

const DEFAULT_SUPPORT_LABEL = "Help";
const DEFAULT_DOCS_LABEL = "Docs";

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// Deliberately permissive: reject obvious garbage (no `@`, whitespace)
// without policing the long tail of valid addresses. The value only ever
// becomes a mailto: href, so a false negative just hides the link.
function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// URL wins over email (documented precedence). A set-but-invalid value is
// dropped with a warning and we fall through — a malformed SUPPORT_URL does
// not silence a valid SUPPORT_EMAIL, and a typo never fails app startup the
// way a bad BETTER_AUTH_SECRET does. undefined → the link never renders.
function resolveSupport(
  url: string | undefined,
  email: string | undefined,
  label: string | undefined,
): SidebarLink | undefined {
  const text = label ?? DEFAULT_SUPPORT_LABEL;
  if (url !== undefined) {
    if (isHttpUrl(url)) return { href: url, label: text, external: true };
    console.warn(`[support] ignoring SUPPORT_URL (not an http(s) URL): ${url}`);
  }
  if (email !== undefined) {
    if (isEmail(email)) {
      return { href: `mailto:${email}`, label: text, external: false };
    }
    console.warn(`[support] ignoring SUPPORT_EMAIL (not an email): ${email}`);
  }
  return undefined;
}

// A safe link target: a same-origin absolute path ("/docs"), or an http(s)
// URL. Rejects protocol-relative ("//host") and javascript:/data:, so an
// operator-set value can't smuggle in a scheme.
function isSafeLinkHref(value: string): boolean {
  if (value.startsWith("//")) return false;
  if (value.startsWith("/")) return true;
  return isHttpUrl(value);
}

// The optional "Docs" link. Accepts a same-origin path ("/docs", the hosted
// default) or an absolute URL (a self-hoster's mirror / the public docs);
// always opens in a new tab since it leaves the app SPA. Invalid → disabled.
function resolveDocs(url: string | undefined): SidebarLink | undefined {
  if (url === undefined) return undefined;
  if (isSafeLinkHref(url)) {
    return { href: url, label: DEFAULT_DOCS_LABEL, external: true };
  }
  console.warn(`[docs] ignoring DOCS_URL (not a path or http(s) URL): ${url}`);
  return undefined;
}

// BETTER_AUTH_SECRET must be ≥32 chars: README's deploy guidance promises
// it, Better Auth's signing primitives degrade below that, and a short
// secret in prod is one of the few failures a self-hoster can't recover
// from after the fact. Fail-fast at startup, not after sign-ups land.
const ServerEnvSchema = z
  .object({
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.url().default("http://localhost:8787"),
    // Optional Google OAuth. Self-hosters who set BOTH halves get a
    // "Continue with Google" button; everyone else keeps email/password
    // only — zero behavior change for them.
    GOOGLE_CLIENT_ID: optionalSecret,
    GOOGLE_CLIENT_SECRET: optionalSecret,
    // Optional PostHog product analytics. Set POSTHOG_KEY (the publishable
    // project key) to turn on client-side analytics; leaving it unset — the
    // OSS default — means no analytics and no third-party script loads.
    // POSTHOG_HOST is the ingestion host, defaulting to PostHog US cloud.
    POSTHOG_KEY: optionalSecret,
    POSTHOG_HOST: optionalSecret,
    // Optional in-app support link (the sidebar "Help" entry). Off by
    // default. Set SUPPORT_URL (a help center / docs / form) OR
    // SUPPORT_EMAIL (rendered as a mailto: link); SUPPORT_URL wins when
    // both are set. SUPPORT_LABEL overrides the default "Help" text. An
    // invalid URL/email disables the link rather than failing startup.
    SUPPORT_URL: optionalSecret,
    SUPPORT_EMAIL: optionalSecret,
    SUPPORT_LABEL: optionalSecret,
    // Optional outbound invite email. Missing or partial config is valid:
    // the invite link is still created and returned for manual sharing.
    // EMAIL_PROVIDER chooses a provider when more than one is configured;
    // unset picks Cloudflare Email Service first, then Resend.
    EMAIL_PROVIDER: optionalSecret,
    EMAIL_FROM: optionalSecret,
    RESEND_API_KEY: optionalSecret,
    // Optional "Docs" link in the sidebar. Off by default. Set DOCS_URL to a
    // same-origin path ("/docs", the hosted default) or an absolute URL. The
    // OSS app ships no docs site, so self-hosters point this at their own
    // mirror or https://corpus.nicia.ai/docs (or leave it off).
    DOCS_URL: optionalSecret,
    // Comma-separated emails granted admin access. An account that signs
    // up with a listed email gets role="admin" stamped at creation (the
    // databaseHook in auth.server.ts), so a fresh deploy bootstraps its first
    // admin by name — no user-id lookup, SQL write, or restart. Further
    // admins are promoted in-app via the admin plugin's setRole.
    ADMIN_EMAILS: z.string().trim().optional(),
  })
  .transform(
    ({
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      POSTHOG_KEY,
      POSTHOG_HOST,
      SUPPORT_URL,
      SUPPORT_EMAIL,
      SUPPORT_LABEL,
      EMAIL_PROVIDER,
      EMAIL_FROM,
      RESEND_API_KEY,
      DOCS_URL,
      ADMIN_EMAILS,
      ...rest
    }) => {
      // Google turns on only when both halves are present; one without the
      // other is a misconfiguration, not partial enablement. Expose the
      // narrowed credential object so callers never re-check for undefined.
      const google =
        GOOGLE_CLIENT_ID !== undefined && GOOGLE_CLIENT_SECRET !== undefined
          ? { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET }
          : undefined;
      // Analytics turns on only with a key; the host falls back to PostHog
      // US cloud (matching the marketing site's default). The shape is the
      // exact payload the browser needs, so the analytics server fn can
      // return it verbatim.
      const posthog =
        POSTHOG_KEY !== undefined
          ? {
              posthogKey: POSTHOG_KEY,
              posthogHost: POSTHOG_HOST ?? "https://us.i.posthog.com",
            }
          : undefined;
      const support = resolveSupport(SUPPORT_URL, SUPPORT_EMAIL, SUPPORT_LABEL);
      const docs = resolveDocs(DOCS_URL);
      const email: EmailConfig = {
        provider: resolveEmailProvider(EMAIL_PROVIDER),
        from: EMAIL_FROM,
        resendApiKey: RESEND_API_KEY,
      };
      // Lowercased so the request-time match is case-insensitive —
      // Better Auth normalizes stored emails to lowercase, but a
      // hand-typed env entry might not.
      const adminEmails = (ADMIN_EMAILS ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      return {
        ...rest,
        google,
        googleEnabled: google !== undefined,
        posthog,
        support,
        docs,
        email,
        adminEmails,
      };
    },
  );

export type ServerEnv = Readonly<z.infer<typeof ServerEnvSchema>>;

export function resolveServerEnv(bindings: Readonly<Env>): ServerEnv {
  // Zod's input is `unknown`, so it reads keys straight off the runtime
  // bindings — the optional Google vars need no entry in the generated
  // `Env` type, and unknown bindings (DB, DO namespaces) are stripped by
  // the object schema.
  return ServerEnvSchema.parse(bindings);
}
