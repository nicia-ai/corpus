import type { EmbassyGrant } from "@/embassy/grant";

function suggestInstructions(url: string): string {
  return `
To propose an edit, do not overwrite. POST the full proposed markdown:
  POST ${url}/suggest
  Content-Type: text/markdown
  X-Doc-Version: {version from GET}
  body: proposed markdown
`;
}

function editInstructions(url: string): string {
  return `
You may edit this page directly. PUT the full updated markdown, as many
times as needed (for example, after each round of feedback):
  PUT ${url}
  Content-Type: text/markdown
  X-Doc-Version: {version from GET}
  body: full markdown

On 409, someone else changed the page: GET it again, keep their changes,
and retry. On 403, the owner wants to review changes: from then on, POST
the full proposed markdown to ${url}/suggest instead (same headers).
`;
}

export function embassyPrompt(input: {
  url: string;
  grant: EmbassyGrant;
  oneLiner?: string;
}): string {
  const write =
    input.grant === "read"
      ? ""
      : input.grant === "suggest"
        ? suggestInstructions(input.url)
        : editInstructions(input.url);
  const then =
    input.oneLiner ??
    (input.grant === "read"
      ? "Read this and help me act on it."
      : "Start from the fetched page.");
  return `You are helping me work with a shared Corpus page.

Fetch the current document:
  GET ${input.url}
  Accept: text/markdown

The response body is markdown. X-Doc-Version is the version you must send back.
${write}
Start by fetching the page. Then: ${then}`;
}
