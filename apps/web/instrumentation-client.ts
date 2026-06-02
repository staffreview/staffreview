import posthog from 'posthog-js';
import { POSTHOG_PUBLIC_TOKEN, POSTHOG_UI_HOST } from '@/lib/posthog-config';

// Only initialize when a project token is configured. When unset (local dev,
// previews, any deploy that forgot it) this is a clean no-op instead of
// `posthog.init(undefined, …)` firing failed `/ingest` requests + console noise.
if (POSTHOG_PUBLIC_TOKEN) {
  posthog.init(POSTHOG_PUBLIC_TOKEN, {
    api_host: '/ingest',
    ui_host: POSTHOG_UI_HOST,
    defaults: '2026-01-30',
    capture_exceptions: true,
    debug: process.env.NODE_ENV === 'development',
  });
}
