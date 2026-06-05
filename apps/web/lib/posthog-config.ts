// Centralized PostHog host/token config shared by the client init
// (`instrumentation-client.ts`) and the server client (`posthog-server.ts`),
// so the two surfaces can't drift.
//
// Client (browser) sends events through the `/ingest` reverse proxy defined in
// `next.config.mjs`; that proxy forwards to the PostHog ingest host below. The
// `ui_host` is only used for links back into the PostHog app.
export const POSTHOG_INGEST_HOST = "https://us.i.posthog.com";
export const POSTHOG_UI_HOST = "https://us.posthog.com";

// Project token. `NEXT_PUBLIC_*` is intentional for the browser client (it must
// be inlined into the bundle). The server reads a non-public override first and
// only falls back to the public token if no server-only one is configured.
export const POSTHOG_PUBLIC_TOKEN = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
export const POSTHOG_SERVER_TOKEN = process.env.POSTHOG_PROJECT_TOKEN ?? POSTHOG_PUBLIC_TOKEN;

// Server-side host. Server requests go directly to PostHog (no `/ingest`
// proxy), so this points at the same ingest host the proxy forwards to.
export const POSTHOG_SERVER_HOST = process.env.POSTHOG_HOST ?? POSTHOG_INGEST_HOST;
