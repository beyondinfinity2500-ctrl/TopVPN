import { glob } from 'astro/loaders';
import { defineCollection, z } from 'astro:content';

const articleBase = z.object({
  title: z.string(),
  description: z.string().max(155),
  primaryKeyword: z.string(),
  tags: z.array(z.string()),
  updatedDate: z.coerce.date(),
  publishedDate: z.coerce.date().optional(),
  draft: z.boolean().default(false),
  reason: z.string().optional(),
  legalNote: z.boolean().optional(),
});

/** English-language guides: country-specific and topical VPN content. */
const articles = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/articles' }),
  schema: articleBase.extend({
    country: z.string().optional(),
  }),
});

/** Arabic-language guides for the Arab VPN markets with the highest demand. */
const articlesAr = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/articles-ar' }),
  schema: articleBase.extend({
    country: z.string().optional(),
  }),
});

export const collections = { articles, articlesAr };