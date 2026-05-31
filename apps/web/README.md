# @staffreview/web

The Staff Review marketing + documentation site — a [Next.js](https://nextjs.org)
app built with [Fumadocs](https://fumadocs.dev). The landing page lives in
`app/(home)/page.tsx`; the docs are MDX under `content/docs/`.

```bash
bun install            # from the monorepo root
bun run dev            # dev server with hot reload  → http://localhost:3000
bun run build          # production build
```

## Layout

| Path | Description |
| --- | --- |
| `app/(home)/page.tsx` | The landing page. |
| `content/docs/*.mdx` | The documentation pages (`content/docs/meta.json` sets order). |
| `lib/source.ts` | Content source adapter — the `loader()` that reads the MDX. |
| `lib/shared.ts` | App name + GitHub config used across layouts. |
| `lib/layout.shared.tsx` | Shared navbar options (logo, links). |
| `app/api/search/route.ts` | Search route handler (Orama). |

Brand assets (`public/icon.png`, `public/screenshot.png`, `app/icon.png`) are
copied from the repo’s `docs/` directory.
