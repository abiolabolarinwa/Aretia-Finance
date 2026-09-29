import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

export const BLOG_CATEGORIES = [
  'Protocol',
  'Wallet',
  'Privacy',
  'Interoperability',
  'Payments',
  'ACT',
  'Climate Finance',
  'Development',
] as const;

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    category: z.enum(BLOG_CATEGORIES),
    date: z.coerce.date(),
    author: z.string().default('Aretia Finance'),
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog };
