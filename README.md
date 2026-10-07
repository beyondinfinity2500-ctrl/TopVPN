# TopVPN

Independent VPN comparison and guide site. Astro + Tailwind CSS v4, fully static: no backend, no database.

## Develop

```bash
npm install
npm run dev      # local preview
npm run build    # output in ./dist
```

## Deploy to Cloudflare Workers (static assets)

1. Push the repo to GitHub and connect it in Cloudflare (Workers & Pages), or run `npm run deploy`.
2. Build command `npm run build`, deploy command `npx wrangler deploy` (config: `wrangler.jsonc`).
3. Add the custom domain `www.topvpn.top`, then add a **Redirect Rule** in the Cloudflare dashboard: `topvpn.top/*` to `https://www.topvpn.top/$1` (301).
4. URLs have no trailing slash (`/about`). The canonical tags match that.
5. `public/_headers` sets caching and security headers. There is no strict CSP on purpose; add one only after you know which ad/analytics hosts you use.

## Edit content

- **Site constants** (name, URL, last-updated date, ads on/off): `src/lib/site.ts`. Change `updated` when page content changes (it feeds the sitemap `lastmod`). Set `ads: true` after AdSense approval.
- **Providers**: `src/data/providers.ts`. Replace `null` with real, verified values and your referral link. The tables and cards automatically show price/location/device columns once real data exists. Never publish numbers you have not checked on the provider's site.
- **Articles**: `src/content/articles/*.md`. Keep `draft: true` until a page has real, original content. Drafts are excluded from pages, tags, related links and the sitemap.

```yaml
---
title: "Best VPN for France"
description: "Max 155 characters."
primaryKeyword: "best VPN for France"
country: "France"
tags: ["privacy", "France"]
publishedDate: 2026-10-07
updatedDate: 2026-10-07
draft: false
---
```

## Analytics, AdSense, Search Console

Commented placeholders are in `src/layouts/BaseLayout.astro`. GA4 loads only after the visitor accepts the cookie banner (see the script at the bottom of that file).

## Adding languages later

Create `src/pages/<lang>/...` with translated pages, add reciprocal `hreflang` links in `BaseLayout.astro`, and translate the provider fields. Do not add hreflang before the translated pages exist.
