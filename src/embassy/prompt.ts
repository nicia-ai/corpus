import type { Grant } from "@/grant";

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
You may edit this page directly. To add or update one part, replace only that
section. The heading text goes in the query (URL-encoded); the body is the
section's content without its heading line. A missing section is added at the
end; a section's subsections belong to it.
  PUT ${url}/section?heading=Participants
  Content-Type: text/markdown
  X-Doc-Version: {version from GET}
  body: new content of that section

Use a whole-page PUT only to rewrite the entire page:
  PUT ${url}
  Content-Type: text/markdown
  X-Doc-Version: {version from GET}
  body: full markdown

On 409, someone else changed the page (or that section): GET it again, keep
their changes, and retry. If a write ends with a 403, POST the full proposed
markdown to ${url}/suggest instead (same headers).
`;
}

function keepWorkingInstructions(url: string): string {
  return `
This page keeps changing. Save this link and these instructions in your
project instructions file (CLAUDE.md, AGENTS.md or similar) so later sessions
can keep working on it:
  ${url}
GET it again at the start of every session before you write.
`;
}

export function embassyPrompt(input: {
  url: string;
  grant: Grant;
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
${write}${keepWorkingInstructions(input.url)}
Start by fetching the page. Then: ${then}`;
}
