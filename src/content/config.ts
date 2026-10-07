import { glob } from 'astro/loaders';
import { defineCollection, z } from 'astro:content';

const articles = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/articles' }),
  schema: z.object({
    title: z.string(),
    description: z.string().max(155),
    primaryKeyword: z.string(),
    country: z.string().optional(),
    tags: z.array(z.string()),
    publishedDate: z.coerce.date().optional(),
    updatedDate: z.coerce.date(),
    reason: z.string().optional(),
    draft: z.boolean().default(false),
    legalNote: z.boolean().optional(),
  }),
});

export const collections = { articles };
