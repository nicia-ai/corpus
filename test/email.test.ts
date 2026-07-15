import { describe, expect, it, vi } from "vitest";

import { type EmailMessage, sendEmail } from "../src/control/email.server";
import { resolveServerEnv } from "../src/control/env.server";

const SECRET = "test-secret-that-is-at-least-32-chars";
const FROM = "Corpus <noreply@example.com>";

const message: EmailMessage = {
  to: "teammate@example.com",
  subject: "Join Corpus",
  html: "<p>Accept</p>",
  text: "Accept: https://corpus.example/invite/abc",
};

function testEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    BETTER_AUTH_SECRET: SECRET,
    BETTER_AUTH_URL: "https://corpus.example",
    ADMIN_EMAILS: "",
    ...overrides,
  } as unknown as Env;
}

function jsonFetch(
  status: number,
  body: unknown = {},
): Readonly<{
  fetcher: typeof fetch;
  calls: {
    input: Parameters<typeof fetch>[0];
    init: RequestInit | undefined;
  }[];
}> {
  const calls: {
    input: Parameters<typeof fetch>[0];
    init: RequestInit | undefined;
  }[] = [];
  const fetcher: typeof fetch = (input, init) => {
    calls.push({ input, init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetcher, calls };
}

function jsonBody(
  call: { init: RequestInit | undefined } | undefined,
): unknown {
  const body = call?.init?.body;
  if (typeof body !== "string") {
    throw new Error("expected string request body");
  }
  return JSON.parse(body);
}

function header(
  call: { init: RequestInit | undefined } | undefined,
  name: string,
): string | null {
  return new Headers(call?.init?.headers).get(name);
}

describe("sendEmail", () => {
  it("drops an unrecognized EMAIL_PROVIDER with a warning, never throwing", () => {
    expect(
      resolveServerEnv(testEnv({ EMAIL_PROVIDER: "" })).email.provider,
    ).toBeUndefined();
    expect(
      resolveServerEnv(testEnv({ EMAIL_PROVIDER: "cloudflare" })).email
        .provider,
    ).toBe("cloudflare");
    expect(
      resolveServerEnv(testEnv({ EMAIL_PROVIDER: "resend" })).email.provider,
    ).toBe("resend");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(
        resolveServerEnv(testEnv({ EMAIL_PROVIDER: "smtp" })).email.provider,
      ).toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("stays silent and returns not-configured when no email config is set", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(sendEmail(testEnv(), message)).resolves.toEqual({
        sent: false,
        reason: "not-configured",
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("warns and returns not-configured when email is partially configured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(
        sendEmail(testEnv({ EMAIL_FROM: FROM }), message),
      ).resolves.toEqual({ sent: false, reason: "not-configured" });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("sends through Resend with direct HTTP", async () => {
    const { fetcher, calls } = jsonFetch(200, {
      id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794",
    });
    await expect(
      sendEmail(
        testEnv({
          EMAIL_PROVIDER: "resend",
          EMAIL_FROM: FROM,
          RESEND_API_KEY: "re_test",
        }),
        message,
        { fetch: fetcher },
      ),
    ).resolves.toEqual({ sent: true });

    const call = calls[0];
    expect(call?.input).toBe("https://api.resend.com/emails");
    expect(header(call, "authorization")).toBe("Bearer re_test");
    expect(header(call, "user-agent")).toBe("corpus/0.1");
    expect(jsonBody(call)).toMatchObject({
      from: FROM,
      to: [message.to],
      subject: message.subject,
      text: message.text,
    });
  });

  it("returns send-failed for a provider non-success response", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { fetcher } = jsonFetch(500, { error: "nope" });
      await expect(
        sendEmail(
          testEnv({
            EMAIL_PROVIDER: "resend",
            EMAIL_FROM: FROM,
            RESEND_API_KEY: "re_test",
          }),
          message,
          { fetch: fetcher },
        ),
      ).resolves.toEqual({ sent: false, reason: "send-failed" });
    } finally {
      warn.mockRestore();
    }
  });

  it("sends through the Cloudflare Email Service binding when present", async () => {
    const sent: unknown[] = [];
    const binding = {
      send: (payload: unknown) => {
        sent.push(payload);
        return Promise.resolve({ messageId: "msg_123" });
      },
    };
    await expect(
      sendEmail(
        testEnv({
          EMAIL_PROVIDER: "cloudflare",
          EMAIL_FROM: FROM,
          EMAIL: binding,
        }),
        message,
      ),
    ).resolves.toEqual({ sent: true });
    expect(sent).toEqual([
      {
        from: FROM,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      },
    ]);
  });

  it("treats Cloudflare as not configured without the Email Service binding", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(
        sendEmail(
          testEnv({
            EMAIL_PROVIDER: "cloudflare",
            EMAIL_FROM: FROM,
          }),
          message,
        ),
      ).resolves.toEqual({ sent: false, reason: "not-configured" });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
