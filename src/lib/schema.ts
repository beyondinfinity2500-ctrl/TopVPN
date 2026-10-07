import { SITE } from './site';

const ORG_ID = `${SITE.url}/#organization`;

/** Organization entity. Emitted on every page that references it, so the @id never dangles. */
export const orgSchema = {
  '@type': 'Organization',
  '@id': ORG_ID,
  name: SITE.name,
  url: SITE.url,
  description: SITE.tagline,
  logo: {
    '@type': 'ImageObject',
    url: `${SITE.url}/icon-512.png`,
    width: 512,
    height: 512,
  },
};

export const websiteSchema = {
  '@type': 'WebSite',
  '@id': `${SITE.url}/#website`,
  url: SITE.url,
  name: SITE.name,
  description: 'Compare the top VPN services for privacy, speed and price.',
  inLanguage: 'en',
  publisher: { '@id': ORG_ID } as Record<string, string>,
};

export function breadcrumbSchema(items: { label: string; href?: string }[]) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.label,
      ...(item.href ? { item: new URL(item.href, SITE.url).href } : {}),
    })),
  };
}

export function articleSchema(opts: {
  headline: string;
  description: string;
  datePublished: string;
  dateModified: string;
  url: string;
  tags?: string[];
}) {
  return {
    '@type': 'Article',
    headline: opts.headline,
    description: opts.description,
    datePublished: opts.datePublished,
    dateModified: opts.dateModified,
    mainEntityOfPage: { '@type': 'WebPage', '@id': opts.url },
    image: `${SITE.url}/og-default.png`,
    inLanguage: 'en',
    // Full inline entities: a bare @id reference is invalid when the Organization
    // is not defined on the same page.
    author: { '@type': 'Organization', name: SITE.name, url: SITE.url },
    publisher: orgSchema,
    ...(opts.tags ? { keywords: opts.tags.join(', ') } : {}),
  };
}

export function itemListSchema(items: { name: string; url: string; description?: string }[]) {
  return {
    '@type': 'ItemList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      url: item.url,
      ...(item.description ? { description: item.description } : {}),
    })),
  };
}

export function faqSchema(items: { question: string; answer: string }[]) {
  return {
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  };
}

export const contextWrapper = (obj: object | object[]) => {
  const arr = Array.isArray(obj) ? obj : [obj];
  return arr.map((o) => ({ '@context': 'https://schema.org', ...o }));
};
