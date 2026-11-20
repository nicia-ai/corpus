import { CliError } from "./errors.js";

// A `fetch` accepting a string URL — the narrow shape the core needs. The
// global `fetch` (and a Worker `Fetcher.fetch`) is assignable to it.
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

// What every call to the REST surface needs: where it is, who is asking, and
// how to reach it.
export type ApiConfig = Readonly<{
  baseUrl: string;
  apiKey: string;
  fetch: FetchLike;
}>;

export async function request(
  cfg: ApiConfig,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${cfg.apiKey}`);
  try {
    return await cfg.fetch(`${cfg.baseUrl}${path}`, { ...init, headers });
  } catch (error) {
    // `fetch` rejects with a TypeError when no response arrived (DNS, TLS,
    // refused connection): a transport failure, not a bug.
    if (error instanceof TypeError) {
      throw new CliError("http", `request failed: ${error.message}`);
    }
    throw error;
  }
}
