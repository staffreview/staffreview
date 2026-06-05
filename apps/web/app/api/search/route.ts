import { createFromSource } from "fumadocs-core/search/server";
import { after } from "next/server";
import { POSTHOG_PUBLIC_TOKEN } from "@/lib/posthog-config";
import { getPostHogClient } from "@/lib/posthog-server";
import { source } from "@/lib/source";

const { GET: searchGET } = createFromSource(source, {
  language: "english",
});

// Reads the visitor's real anonymous `distinct_id` from the posthog-js cookie
// (`ph_<token>_posthog` -> `distinct_id`) so server-side events tie back to the
// same person the browser tracks, instead of a single synthetic "anonymous"
// user. Returns null if the cookie/token isn't present.
function getDistinctId(request: Request): string | null {
  if (!POSTHOG_PUBLIC_TOKEN) return null;
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  const name = `ph_${POSTHOG_PUBLIC_TOKEN}_posthog`;
  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rawVal] = part.split("=");
    if (rawKey.trim() !== name) continue;
    try {
      const parsed = JSON.parse(decodeURIComponent(rawVal.join("=")));
      return typeof parsed?.distinct_id === "string" ? parsed.distinct_id : null;
    } catch {
      return null;
    }
  }
  return null;
}

// Fire-and-forget analytics: never block or break the search response on a
// PostHog round-trip. We don't await the capture/flush; failures are swallowed.
function captureSearch(request: Request, query: string) {
  try {
    const distinctId = getDistinctId(request);
    if (!distinctId) return;
    const client = getPostHogClient();
    if (!client) return;
    client.capture({
      distinctId,
      event: "docs_searched",
      // Deliberately do NOT send the raw query string (possible PII: users
      // sometimes paste secrets/emails). We retain analytic value by recording
      // only the query length.
      properties: { query_length: query.length },
    });
    // Flush after the response is sent so it never blocks/breaks search, while
    // still tying the work to the request lifetime. On OpenNext/Cloudflare
    // Workers `after()` maps to `ctx.waitUntil()`, so the post-response flush
    // actually runs instead of being dropped once the response returns.
    after(async () => {
      try {
        await client.shutdown();
      } catch {
        // Analytics must never take down search.
      }
    });
  } catch {
    // Analytics must never take down search.
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("query");

  if (query) {
    captureSearch(request, query);
  }

  return searchGET(request);
}
