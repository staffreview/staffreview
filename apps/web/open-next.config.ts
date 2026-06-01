import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Docs site: no persistent ISR/incremental cache is configured, so we don't
// need an R2 bucket binding. Pages are server-rendered on the Workers Node.js
// runtime (Fumadocs does not support the Edge runtime). To enable a shared
// incremental cache later, add an `incrementalCache` override (e.g. the R2
// one) here and wire up the matching binding in wrangler.jsonc.
export default defineCloudflareConfig({});
