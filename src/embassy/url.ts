export function embassyPath(id: string): string {
  return `/s/${id}`;
}

export function embassyUrl(origin: string, id: string): string {
  return `${origin}${embassyPath(id)}`;
}

// A file the shared page references, by content hash only: no path appears in
// the URL, and the route re-checks the hash against the page's current head.
export function embassyFilePath(id: string, hash: string): string {
  return `${embassyPath(id)}/f/${hash}`;
}
