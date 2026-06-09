# Security Policy Notes

Use these notes as local research input for the risk and policy agent. They are
deliberately phrased as internal observations, not legal advice.

## Main Risks

- Sensitive prompts: engineers may paste customer data, secrets, incident
  details, unreleased strategy, or proprietary architecture into tools that are
  not approved for that data class.
- Generated code review: AI output can introduce insecure patterns, outdated
  dependencies, hallucinated APIs, or license-sensitive snippets.
- Tool sprawl: unmanaged personal accounts make it hard to know which vendors
  handled source code.
- Audit gap: security teams need a way to answer who can use which tools and
  what review process applies before code reaches production.

## Practical Guardrails

- Maintain an approved AI coding tool list.
- Require SSO or company-managed accounts for tools used with source code.
- Prohibit secrets, credentials, customer data, and unreleased business plans in
  prompts unless the vendor and data class are explicitly approved.
- Require human code review, tests, and normal secure development checks before
  merge.
- Log exceptions and assign an owner for policy updates.

## Rollout Shape

- Start with a small pilot in engineering.
- Publish a plain-language policy and a short FAQ for customer-facing teams.
- Review pilot findings with security and legal after 30 days.
- Expand only after there is a documented vendor list and exception process.
