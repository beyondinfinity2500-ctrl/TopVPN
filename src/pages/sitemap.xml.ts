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
 *
 * Arabic articles live at /ar/articles/<id> and mirror the English article of
 * the same id; each carries an hreflang pair so Google serves the right language.
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

/** hreflang alternates for an article: English at /articles/<id>, Arabic at
 *  /ar/articles/<id>. The English alternate is only emitted when the English
 *  article actually exists, so an Arabic-only guide never points at a 404. */
function articleAlternates(id: string, englishIds: Set<string>): string {
  const hasEnglish = englishIds.has(id);
  const links: string[] = [];
  if (hasEnglish) {
    links.push(`    <xhtml:link rel="alternate" hreflang="en" href="${SITE.url}/articles/${id}"/>`);
  }
  links.push(`    <xhtml:link rel="alternate" hreflang="ar" href="${SITE.url}/ar/articles/${id}"/>`);
  if (hasEnglish) {
    links.push(`    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE.url}/articles/${id}"/>`);
  }
  return links.join('\n');
}

export const GET: APIRoute = async () => {
  const articles = await getCollection('articles', ({ data }) => !data.draft);
  const articlesAr = await getCollection('articlesAr', ({ data }) => !data.draft);
  const englishIds = new Set(articles.map((a) => a.id));

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

  // English articles (each carries its own real updatedDate).
  for (const a of articles) {
    const lastmod = a.data.updatedDate.toISOString().split('T')[0];
    urlEntries.push(`  <url>\n    <loc>${SITE.url}/articles/${a.id}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`);
  }

  // Arabic articles: paired with the English article of the same id.
  for (const a of articlesAr) {
    const lastmod = a.data.updatedDate.toISOString().split('T')[0];
    urlEntries.push(
      `  <url>\n    <loc>${SITE.url}/ar/articles/${a.id}</loc>\n    <lastmod>${lastmod}</lastmod>\n${articleAlternates(a.id, englishIds)}\n  </url>`,
    );
  }

  // Tag archive pages (clean slugs; lastmod = newest article in that tag).
  const tags = [...new Set([...articles, ...articlesAr].flatMap((a) => a.data.tags))];
  for (const tag of tags) {
    const matches = [...articles, ...articlesAr].filter((a) => a.data.tags.includes(tag));
    const newest = matches.reduce((max, a) => (a.data.updatedDate > max ? a.data.updatedDate : max), matches[0].data.updatedDate);
    urlEntries.push(`  <url>\n    <loc>${SITE.url}/tags/${slugifyTag(tag)}</loc>\n    <lastmod>${newest.toISOString().split('T')[0]}</lastmod>\n  </url>`);
  }

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urlEntries.join('\n')}
</urlset>
`;

  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};