// The same-origin check for a cookie-authenticated, state-changing request
// that does NOT pass through TanStack Start's CSRF middleware (`src/start.tsx`
// guards server functions only): the Hono routes. It applies the same rule
// that middleware does, in the same order, so the two surfaces agree:
//
//   1. `Sec-Fetch-Site` (sent by every current browser, unforgeable from
//      script) must be `same-origin`;
//   2. otherwise `Origin` must equal the request's own origin;
//   3. otherwise `Referer` must be on the request's own origin;
//   4. a request that carries none of them is refused. A browser that sends
//      none of the three is not one we can vouch for, and a non-browser
//      client has no ambient cookie to ride, so it loses nothing by using a
//      bearer credential on a bearer route instead.
const SAME_ORIGIN = "same-origin";

export function isSameOriginRequest(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null) return fetchSite === SAME_ORIGIN;
  const own = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === own;
  const referer = request.headers.get("referer");
  if (referer === null) return false;
  try {
    return new URL(referer).origin === own;
  } catch {
    return false;
  }
}
