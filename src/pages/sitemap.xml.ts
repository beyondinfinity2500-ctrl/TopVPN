import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { SITE } from '../lib/site';

/** Public, indexable pages. Edit SITE.updated in src/lib/site.ts when page content changes. */
const staticPaths = [
  '/',
  '/order-vpn',
  '/articles',
  '/vpn-types-guide',
  '/connection-guide',
  '/apps',
  '/about',
  '/advertise',
  '/contact',
  '/affiliate-disclosure',
  '/privacy-policy',
  '/terms',
];

export const GET: APIRoute = async () => {
  const articles = await getCollection('articles', ({ data }) => !data.draft);

  const entries = [
    ...staticPaths.map((path) => ({ path, lastmod: SITE.updated })),
    ...articles.map((a) => ({
      path: `/articles/${a.id}`,
      lastmod: a.data.updatedDate.toISOString().split('T')[0],
    })),
  ];

  // Google ignores <changefreq> and <priority>; only an accurate <lastmod> is useful.
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries
  .map((e) => `  <url><loc>${SITE.url}${e.path === '/' ? '' : e.path}</loc><lastmod>${e.lastmod}</lastmod></url>`)
  .join('\n')}
</urlset>
`;

  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
