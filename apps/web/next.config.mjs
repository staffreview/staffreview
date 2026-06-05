import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Fumadocs markdown URLs. These were in proxy.ts, but Next 16 runs proxy on
  // the Node.js runtime, which the Cloudflare/OpenNext adapter can't deploy.
  // Expressed here as routing-layer rewrites (beforeFiles, to intercept like
  // the proxy did) the adapter does support.
  async rewrites() {
    return {
      beforeFiles: [
        // `/docs/<path>.md` -> the raw markdown content route.
        {
          source: "/docs/:path(.*)\\.md",
          destination: "/llms.mdx/docs/:path/content.md",
        },
        // Serve raw markdown when the client explicitly accepts it (LLM
        // crawlers, `curl -H "Accept: text/markdown"`). Browsers send
        // text/html, don't match, and fall through to the normal page.
        {
          source: "/docs/:path(.*)",
          has: [{ type: "header", key: "accept", value: ".*text/markdown.*" }],
          destination: "/llms.mdx/docs/:path/content.md",
        },
      ],
      afterFiles: [
        {
          source: "/ingest/static/:path*",
          destination: "https://us-assets.i.posthog.com/static/:path*",
        },
        {
          source: "/ingest/array/:path*",
          destination: "https://us-assets.i.posthog.com/array/:path*",
        },
        {
          source: "/ingest/:path*",
          destination: "https://us.i.posthog.com/:path*",
        },
      ],
    };
  },
  skipTrailingSlashRedirect: true,
};

export default withMDX(config);

// Enables Cloudflare bindings (via `getCloudflareContext`) during `next dev`.
// No-op outside local development, so it's safe to keep for production builds.
initOpenNextCloudflareForDev();
