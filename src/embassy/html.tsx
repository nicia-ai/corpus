import { renderToString } from "react-dom/server";

import { MarkdownContent } from "@/components/markdown/Markdown";
import type { EmbassyGrant } from "@/embassy/grant";
import { embassyPrompt } from "@/embassy/prompt";
import { parseFrontmatter } from "@/store/domain/frontmatter";

const PAGE_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; color: #0f172a; font-family: ui-sans-serif, system-ui, sans-serif; }
  .wrap { max-width: 48rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
  .card { border: 1px solid #e2e8f0; border-radius: 0.5rem; padding: 1rem 1.25rem; margin-bottom: 1.5rem; background: #f8fafc; }
  .card h2 { margin: 0 0 0.5rem; font-size: 1rem; font-weight: 600; }
  .card p { margin: 0 0 0.75rem; color: #475569; font-size: 0.95rem; line-height: 1.5; }
  textarea { width: 100%; min-height: 12rem; font-family: ui-monospace, monospace; font-size: 0.8rem; line-height: 1.45; border: 1px solid #cbd5e1; border-radius: 0.375rem; padding: 0.75rem; background: #fff; }
  button.copy { margin-top: 0.75rem; min-height: 2.75rem; padding: 0.4rem 0.85rem; border: 0; border-radius: 0.375rem; background: #2563eb; color: #fff; font-weight: 500; font-size: 0.875rem; cursor: pointer; }
  button.copy:hover { background: #1d4ed8; }
  .md { font-size: 1.125rem; line-height: 1.7; }
  .md h1 { font-size: 1.875rem; letter-spacing: -0.02em; }
  .md h2 { font-size: 1.5rem; letter-spacing: -0.015em; }
  .md pre, .md code { font-family: ui-monospace, monospace; font-size: 0.9em; }
  .gone { padding: 4rem 1.25rem; text-align: center; color: #475569; }
`;

export function embassyGoneHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="referrer" content="no-referrer"/>
  <title>Link expired</title>
  <style>${PAGE_CSS}</style>
</head>
<body><p class="gone">This shared page is no longer available.</p></body>
</html>`;
}

export function embassyPageHtml(input: {
  title: string;
  markdown: string;
  url: string;
  grant: EmbassyGrant;
}): string {
  const prompt = embassyPrompt({ url: input.url, grant: input.grant });
  const fm = parseFrontmatter(input.markdown);
  const source = fm.ok ? fm.body : input.markdown;
  const body = renderToString(<MarkdownContent source={source} />);
  const escaped = escapeHtml(prompt);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="referrer" content="no-referrer"/>
  <title>${escapeHtml(input.title)}</title>
  <style>${PAGE_CSS}</style>
</head>
<body>
  <div class="wrap">
    <section class="card">
      <h2>Give this to your agent</h2>
      <p>Copy the prompt and paste it into Claude Code, Codex, or any agent that can fetch a URL.</p>
      <textarea id="prompt" readonly>${escaped}</textarea>
      <button type="button" class="copy" id="copy">Copy prompt</button>
    </section>
    <article class="md">${body}</article>
  </div>
  <script>
    const t = document.getElementById("prompt");
    document.getElementById("copy")?.addEventListener("click", async () => {
      const v = t?.value ?? "";
      try { await navigator.clipboard.writeText(v); } catch {}
    });
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => {
    if (ch === "&") return "&" + "amp;";
    if (ch === "<") return "&" + "lt;";
    if (ch === ">") return "&" + "gt;";
    return "&" + "quot;";
  });
}
