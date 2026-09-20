import type { EmbassyGrant } from "@/embassy/grant";

export function embassyPrompt(input: {
  url: string;
  grant: EmbassyGrant;
  oneLiner?: string;
}): string {
  const write =
    input.grant === "read"
      ? ""
      : input.grant === "suggest"
        ? `
To propose an edit, do not overwrite. POST the full proposed markdown:
  POST ${input.url}/suggest
  Content-Type: text/markdown
  X-Doc-Version: {version from GET}
  body: proposed markdown
`
        : `
This is an intake page. Replace it once with your result:
  PUT ${input.url}
  Content-Type: text/markdown
  X-Doc-Version: {version from GET}
  body: markdown
`;
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
