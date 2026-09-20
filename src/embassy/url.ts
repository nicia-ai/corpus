export function embassyPath(id: string): string {
  return `/s/${id}`;
}

export function embassyUrl(origin: string, id: string): string {
  return `${origin}${embassyPath(id)}`;
}
