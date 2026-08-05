const GITHUB_PAGES_ORIGIN = "https://bidaipro.github.io";

export function publicApiHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  headers.set("Access-Control-Allow-Origin", GITHUB_PAGES_ORIGIN);
  headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Accept, Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  return headers;
}

export function publicApiPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: publicApiHeaders(),
  });
}
