import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { SITE, slugifyTag } from '../lib/site';

/**
 * Single sitemap following the sitemaps.org 0.9 protocol + Google's
 * localized-versions guidance:
 *  - one <url> entry per language URL (each translated page appears once per
 *    language, never only as an alternate);
 *  - <xhtml:link rel="alternate"> children listing EVERY variant including
 *    itself, plus x-default -> English (the site default);
 *  - accurate <lastmod> only (no changefreq/priority — Google ignores them);
 *  - absolute URLs, UTF-8, protocol namespace.
 * When adding a language, extend LANGS and the TRANSLATED base paths.
 */

const LANGS: { hreflang: string; prefix: string }[] = [
  { hreflang: 'en', prefix: '' },
  { hreflang: 'ar', prefix: '/ar' },
  { hreflang: 'pcm', prefix: '/pcm' },
];

/** Base paths that exist in every language. */
const TRANSLATED = [
  '/', '/about', '/apps', '/order-vpn', '/vpn-servers', '/vpn-types-guide',
  '/connection-guide', '/articles', '/contact', '/advertise',
  '/privacy-policy', '/terms', '/affiliate-disclosure',
];

/** Static paths WITHOUT language variants. */
const staticPaths = [
  '/order-vpn',
  '/articles',
  '/vpn-types-guide',
  '/connection-guide',
  '/apps',
  '/vpn-servers',
  '/advertise',
  '/contact',
  '/affiliate-disclosure',
  '/privacy-policy',
  '/terms',
];

/** Absolute URL for a language variant of a base path. Must match each page's
 *  canonical exactly: home is "https://www.topvpn.top/", variants have no
 *  trailing slash ("/ar", "/pcm/about"). */
function urlFor(basePath: string, prefix: string): string {
  if (basePath === '/') {
    return prefix ? `${SITE.url}${prefix}` : `${SITE.url}/`;
  }
  return `${SITE.url}${prefix}${basePath}`;
}

function alternateLinks(basePath: string): string {
  const links = LANGS.map(
    (lang) => `    <xhtml:link rel="alternate" hreflang="${lang.hreflang}" href="${urlFor(basePath, lang.prefix)}"/>`,
  );
  links.push(`    <xhtml:link rel="alternate" hreflang="x-default" href="${urlFor(basePath, '')}"/>`);
  return links.join('\n');
}

export const GET: APIRoute = async () => {
  const articles = await getCollection('articles', ({ data }) => !data.draft);

  const urlEntries: string[] = [];

  // Translated pages: one <url> per language, each carrying the full alternate set.
  for (const basePath of TRANSLATED) {
    for (const lang of LANGS) {
      urlEntries.push(
        `  <url>\n    <loc>${urlFor(basePath, lang.prefix)}</loc>\n    <lastmod>${SITE.updated}</lastmod>\n${alternateLinks(basePath)}\n  </url>`,
      );
    }
  }

  // Untranslated static pages.
  for (const path of staticPaths) {
    urlEntries.push(`  <url>\n    <loc>${SITE.url}${path}</loc>\n    <lastmod>${SITE.updated}</lastmod>\n  </url>`);
  }

  // Articles (English; each carries its own real updatedDate).
  for (const a of articles) {
    const lastmod = a.data.updatedDate.toISOString().split('T')[0];
    urlEntries.push(`  <url>\n    <loc>${SITE.url}/articles/${a.id}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`);
  }

  // Tag archive pages (clean slugs; lastmod = newest article in that tag).
  const tags = [...new Set(articles.flatMap((a) => a.data.tags))];
  for (const tag of tags) {
    const newest = articles
      .filter((a) => a.data.tags.includes(tag))
      .reduce((max, a) => (a.data.updatedDate > max ? a.data.updatedDate : max), articles[0].data.updatedDate);
    urlEntries.push(`  <url>\n    <loc>${SITE.url}/tags/${slugifyTag(tag)}</loc>\n    <lastmod>${newest.toISOString().split('T')[0]}</lastmod>\n  </url>`);
  }

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urlEntries.join('\n')}
</urlset>
`;

  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
