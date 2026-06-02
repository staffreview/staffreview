import { PostHog } from 'posthog-node';
import { POSTHOG_SERVER_HOST, POSTHOG_SERVER_TOKEN } from '@/lib/posthog-config';

// Returns a server-side PostHog client, or `null` when no token is configured
// so callers can cleanly skip analytics instead of constructing an unusable
// client. Uses non-public server env (with a public-token fallback) and the
// centralized ingest host so the server can't drift from the browser client.
export function getPostHogClient(): PostHog | null {
  if (!POSTHOG_SERVER_TOKEN) return null;
  return new PostHog(POSTHOG_SERVER_TOKEN, {
    host: POSTHOG_SERVER_HOST,
    flushAt: 1,
    flushInterval: 0,
  });
}
