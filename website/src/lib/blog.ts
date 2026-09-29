import { getCollection, type CollectionEntry } from 'astro:content';

export const categorySlug = (category: string): string => category.toLowerCase().replace(/\s+/g, '-');

export async function getPublishedPosts(): Promise<CollectionEntry<'blog'>[]> {
  const posts = await getCollection('blog', ({ data }) => !data.draft);
  return posts.sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
}
