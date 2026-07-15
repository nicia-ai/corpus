import { resolveServerEnv, type EmailConfig } from "./env.server";

export type EmailSendFailureReason = "not-configured" | "send-failed";

export type SendEmailResult = Readonly<
  { sent: true } | { sent: false; reason: EmailSendFailureReason }
>;

export type EmailMessage = Readonly<{
  to: string;
  subject: string;
  html: string;
  text: string;
}>;

type Fetcher = typeof fetch;

type SendEmailDeps = Readonly<{
  fetch?: Fetcher;
}>;

type Sender =
  | Readonly<{ provider: "cloudflare"; binding: SendEmail }>
  | Readonly<{ provider: "resend"; apiKey: string }>;

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const USER_AGENT = "corpus/0.1";
// Fail soft: a hung provider must not stall the invite request up to the
// Workers subrequest ceiling. A timeout surfaces as send-failed below.
const RESEND_TIMEOUT_MS = 5_000;

// `EMAIL` is an optional `send_email` binding absent from the generated `Env`,
// so it arrives as `unknown` after the `in` narrowing; the structural guard
// re-establishes the generated `SendEmail` shape.
function isCloudflareEmailBinding(value: unknown): value is SendEmail {
  return (
    typeof value === "object" &&
    value !== null &&
    "send" in value &&
    typeof value.send === "function"
  );
}

function cloudflareEmailBinding(env: Readonly<Env>): SendEmail | undefined {
  if (!("EMAIL" in env)) return undefined;
  return isCloudflareEmailBinding(env.EMAIL) ? env.EMAIL : undefined;
}

function configuredSender(
  env: Readonly<Env>,
  email: EmailConfig,
): Sender | undefined {
  const binding = cloudflareEmailBinding(env);
  const resend =
    email.resendApiKey === undefined
      ? undefined
      : { provider: "resend" as const, apiKey: email.resendApiKey };

  if (email.provider === "cloudflare") {
    return binding === undefined
      ? undefined
      : { provider: "cloudflare", binding };
  }
  if (email.provider === "resend") return resend;
  if (binding !== undefined) {
    return { provider: "cloudflare", binding };
  }
  return resend;
}

// "Intent" = the operator set at least one email knob. A fully unset config is
// the OSS default (copy-link only) and stays silent; a partial config is a
// likely misconfiguration worth warning about, in production too. The invite
// URL is a show-once secret, so it is never logged.
function hasEmailIntent(env: Readonly<Env>, email: EmailConfig): boolean {
  return (
    email.from !== undefined ||
    email.resendApiKey !== undefined ||
    email.provider !== undefined ||
    cloudflareEmailBinding(env) !== undefined
  );
}

function warnPartiallyConfigured(env: Readonly<Env>, email: EmailConfig): void {
  if (!hasEmailIntent(env, email)) return;
  console.warn(
    "[email] invite email is partially configured and was skipped; set EMAIL_FROM plus a provider (RESEND_API_KEY, or a Cloudflare EMAIL binding)",
  );
}

function logSendFailed(sender: Sender, error: unknown): void {
  console.warn("[email] send failed", {
    provider: sender.provider,
    error,
  });
}

async function sendWithResend(
  fetcher: Fetcher,
  sender: Extract<Sender, { provider: "resend" }>,
  from: string,
  message: EmailMessage,
): Promise<boolean> {
  const response = await fetcher(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sender.apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      from,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
    }),
    signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
  });
  return response.ok;
}

async function sendWithCloudflareBinding(
  sender: Extract<Sender, { provider: "cloudflare" }>,
  from: string,
  message: EmailMessage,
): Promise<boolean> {
  await sender.binding.send({
    from,
    to: message.to,
    subject: message.subject,
    html: message.html,
    text: message.text,
  });
  return true;
}

export async function sendEmail(
  env: Readonly<Env>,
  message: EmailMessage,
  deps: SendEmailDeps = {},
): Promise<SendEmailResult> {
  const runtime = resolveServerEnv(env);
  const { from } = runtime.email;
  const sender = configuredSender(env, runtime.email);
  if (from === undefined || sender === undefined) {
    warnPartiallyConfigured(env, runtime.email);
    return { sent: false, reason: "not-configured" };
  }

  try {
    const ok =
      sender.provider === "resend"
        ? await sendWithResend(deps.fetch ?? fetch, sender, from, message)
        : await sendWithCloudflareBinding(sender, from, message);
    if (ok) return { sent: true };
    logSendFailed(sender, "non-2xx response");
    return { sent: false, reason: "send-failed" };
  } catch (error) {
    logSendFailed(sender, error);
    return { sent: false, reason: "send-failed" };
  }
}
