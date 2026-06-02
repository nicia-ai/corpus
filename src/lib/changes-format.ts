// Presentational formatting for change events, shared by the Changes
// page and the dashboard's recent-activity list so the two render the
// stored vocabulary identically.

// Event names are the internal dotted vocabulary (`collection.attached`);
// render them as words without changing the stored value.
export function humanize(eventType: string): string {
  const words = eventType
    .replace(/[._-]/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// `""` = no user (system/migration), `"import"` = bundle import. Both
// are sentinels the server couldn't resolve to a person.
export function actor(name: string | undefined, raw: string): string {
  if (name !== undefined) return name;
  if (raw === "") return "System";
  if (raw === "import") return "Imported";
  return raw;
}

// What the event acted on: a document event names its document, a
// collection event its collection. One rule so the feed never shows a
// bare "—" when the ledger actually recorded a subject.
export function subject(
  c: Readonly<{
    documentSlug: string | null;
    collectionSlug?: string | null;
  }>,
): string | undefined {
  return c.documentSlug ?? c.collectionSlug ?? undefined;
}
